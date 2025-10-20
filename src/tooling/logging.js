import process from 'node:process';
import { getValidator } from '../validate.js';

export const LOG_CONTRACT_ID = 'lcod://contract/tooling/log@1';
export const KERNEL_HELPER_ID = 'lcod://kernel/log@1';
export const LOG_CONTEXT_HELPER_ID = 'lcod://tooling/log.context@1';

const LEVEL_ORDER = new Map([
  ['trace', 0],
  ['debug', 1],
  ['info', 2],
  ['warn', 3],
  ['error', 4],
  ['fatal', 5]
]);

const LOG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['level', 'message'],
  properties: {
    level: { type: 'string', enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] },
    message: { type: 'string', minLength: 1 },
    data: { type: 'object' },
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        stack: { type: 'string' },
        type: { type: 'string' }
      },
      additionalProperties: true
    },
    tags: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean'] }
    },
    timestamp: {
      type: 'string',
      format: 'date-time'
    }
  }
};

let cachedValidator;
let cachedThreshold;

async function ensureValidator() {
  if (!cachedValidator) {
    cachedValidator = await getValidator(LOG_SCHEMA);
  }
  return cachedValidator;
}

function parseLevelThreshold(value) {
  if (!value || typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return LEVEL_ORDER.get(normalized);
}

function getThreshold() {
  if (cachedThreshold === undefined) {
    cachedThreshold = parseLevelThreshold(process.env.LCOD_LOG_LEVEL) ?? LEVEL_ORDER.get('fatal');
  }
  return cachedThreshold;
}

function levelRank(level) {
  return LEVEL_ORDER.get(level) ?? LEVEL_ORDER.get('info');
}

function hasCustomBinding(binding) {
  return Boolean(binding && binding !== KERNEL_HELPER_ID && binding !== LOG_CONTRACT_ID);
}

export function setKernelLogLevel(level) {
  const parsed = parseLevelThreshold(level);
  if (parsed !== undefined) {
    cachedThreshold = parsed;
  }
}

function stableTags(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[key] = val;
    }
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function writeFallback(entry) {
  try {
    const payload = JSON.stringify(entry);
    const component =
      entry?.tags && typeof entry.tags === 'object' ? entry.tags.component : undefined;
    const useStderr =
      entry.level === 'error' || entry.level === 'fatal' || component === 'kernel';
    (useStderr ? process.stderr : process.stdout).write(`${payload}\n`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`{"level":"error","message":"failed to stringify log","error":"${msg}"}\n`);
  }
}

async function emitLog(ctx, input, kernelTags) {
  const validator = await ensureValidator();
  const payload = { ...input };

  const declaredLevel =
    typeof payload.level === 'string' ? payload.level.trim().toLowerCase() : undefined;
  const bindingId = ctx.registry.bindings?.[LOG_CONTRACT_ID];
  const customBinding = hasCustomBinding(bindingId) && !kernelTags;
  if (declaredLevel && LEVEL_ORDER.has(declaredLevel)) {
    if (levelRank(declaredLevel) < getThreshold() && !customBinding) {
      return {};
    }
  }

  if (!payload.timestamp) {
    payload.timestamp = nowIso();
  }

  const scopeTags = ctx._logScope?.length ? Object.assign({}, ...ctx._logScope) : {};
  const combinedTags = { ...scopeTags, ...kernelTags, ...stableTags(payload.tags) };
  if (Object.keys(combinedTags).length) {
    payload.tags = combinedTags;
  } else {
    delete payload.tags;
  }

  const valid = validator(payload);
  if (!valid) {
    const errors = (validator.errors || []).map(e => `${e.instancePath} ${e.message}`).join('; ');
    writeFallback({ level: 'error', message: 'invalid log payload', data: { errors } });
    return {};
  }

  const binding = ctx.registry.bindings?.[LOG_CONTRACT_ID];
  if (hasCustomBinding(binding)) {
    const impl = ctx.registry.get(binding);
    if (impl && typeof impl.fn === 'function') {
      try {
        const result = await impl.fn(ctx, payload, {});
        return result ?? payload;
      } catch (err) {
        writeFallback({
          level: 'error',
          message: 'log contract handler failed',
          data: { message: err?.message },
          timestamp: nowIso(),
          tags: combinedTags
        });
        return payload;
      }
    }
  }

  writeFallback(payload);
  return payload;
}

export function registerLogging(registry) {
  registry.register(LOG_CONTRACT_ID, async (ctx, input = {}) => emitLog(ctx, input, {}));
  registry.register(KERNEL_HELPER_ID, async (ctx, input = {}) => emitLog(ctx, input, { component: 'kernel' }));

  registry.register(LOG_CONTEXT_HELPER_ID, async (ctx, input = {}, meta = {}) => {
    const tags = stableTags(input.tags);
    pushLogScope(ctx, tags);
    try {
      const children = meta?.children?.children;
      if (!Array.isArray(children) || children.length === 0) {
        return {};
      }
      if (typeof ctx.runChildren !== 'function') {
        throw new Error('tooling/log.context@1 requires child steps but runChildren is unavailable');
      }
      return (await ctx.runChildren(children, undefined, undefined)) ?? {};
    } finally {
      popLogScope(ctx);
    }
  });

  return registry;
}

export function pushLogScope(ctx, tags) {
  if (!ctx._logScope) ctx._logScope = [];
  ctx._logScope.push(stableTags(tags));
}

export function popLogScope(ctx) {
  if (!ctx._logScope || ctx._logScope.length === 0) return;
  ctx._logScope.pop();
}

function createFallbackContext() {
  return {
    registry: {
      bindings: {},
      get: () => undefined
    },
    _logScope: []
  };
}

function normalizeLogOptions(options = {}) {
  const out = {};
  if (options && typeof options === 'object') {
    if (options.data && typeof options.data === 'object' && Object.keys(options.data).length > 0) {
      out.data = options.data;
    }
    if (options.tags && typeof options.tags === 'object' && Object.keys(options.tags).length > 0) {
      out.tags = options.tags;
    }
  }
  return out;
}

async function emitKernelLog(ctx, level, message, options = {}) {
  const payload = {
    level,
    message,
    ...normalizeLogOptions(options)
  };
  const targetCtx = ctx && typeof ctx === 'object' ? ctx : createFallbackContext();
  try {
    await emitLog(targetCtx, payload, { component: 'kernel' });
  } catch (err) {
    writeFallback({
      level: 'error',
      message: 'failed to emit kernel log',
      timestamp: nowIso(),
      data: {
        originalLevel: level,
        originalMessage: message,
        error: err?.message
      },
      tags: { component: 'kernel' }
    });
  }
}

export function logKernelDebug(ctx, message, options) {
  return emitKernelLog(ctx, 'debug', message, options);
}

export function logKernelInfo(ctx, message, options) {
  return emitKernelLog(ctx, 'info', message, options);
}

export function logKernelWarn(ctx, message, options) {
  return emitKernelLog(ctx, 'warn', message, options);
}

export function logKernelError(ctx, message, options) {
  return emitKernelLog(ctx, 'error', message, options);
}
