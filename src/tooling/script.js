import vm from 'node:vm';
import { inspect } from 'node:util';

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function resolvePath(state, path) {
  if (!path) return undefined;
  let cursor = state;
  const normalized = path.startsWith('$.') ? path.slice(2) : path.replace(/^\$\./, '');
  const parts = normalized.split('.').filter(Boolean);
  for (const part of parts) {
    if (cursor == null) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function buildBindings(inputState, bindings = {}) {
  if (!bindings || typeof bindings !== 'object') return {};
  const resolved = {};
  for (const [name, descriptor] of Object.entries(bindings)) {
    if (!descriptor || typeof descriptor !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      resolved[name] = deepClone(descriptor.value);
      continue;
    }
    if (typeof descriptor.path === 'string') {
      const value = resolvePath(inputState, descriptor.path);
      if (typeof value === 'undefined' && Object.prototype.hasOwnProperty.call(descriptor, 'default')) {
        resolved[name] = deepClone(descriptor.default);
      } else {
        resolved[name] = deepClone(value);
      }
    }
  }
  return resolved;
}

function setDeepValue(target, path, value) {
  if (!path) return;
  const normalized = path.startsWith('$.') ? path.slice(2) : path;
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cursor[key] == null || typeof cursor[key] !== 'object') {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function decodeChunk(chunk, encoding) {
  if (encoding === 'base64') return Buffer.from(chunk, 'base64');
  if (encoding === 'hex') return Buffer.from(chunk, 'hex');
  return Buffer.from(chunk, 'utf8');
}

function registerStreams(ctx, state, specs) {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!spec || typeof spec.target !== 'string' || !Array.isArray(spec.chunks)) continue;
    const encoding = typeof spec.encoding === 'string' ? spec.encoding.toLowerCase() : 'utf-8';
    const decoded = spec.chunks.map(chunk => decodeChunk(String(chunk ?? ''), encoding));
    const handle = ctx.streams.createFromAsyncGenerator(async function* () {
      for (const piece of decoded) {
        yield piece;
      }
    }, { encoding });
    setDeepValue(state, spec.target, handle);
  }
}

function compileFunction(source, sandbox, timeout) {
  const wrapped = `(${source})`;
  const script = new vm.Script(wrapped, { displayErrors: true, timeout });
  const fn = script.runInContext(sandbox, { timeout });
  if (typeof fn !== 'function') {
    throw new Error('Script source must evaluate to a function');
  }
  return fn;
}

function buildTools(toolDefs, sandbox, defaultTimeout) {
  const tools = new Map();
  if (!Array.isArray(toolDefs)) return tools;
  for (const def of toolDefs) {
    if (!def || typeof def.name !== 'string' || typeof def.source !== 'string') continue;
    const timeout = typeof def.timeoutMs === 'number' ? Math.max(1, def.timeoutMs) : defaultTimeout;
    try {
      const fn = compileFunction(def.source, sandbox, timeout);
      tools.set(def.name, { fn, timeout });
    } catch (err) {
      throw new Error(`Failed to compile tool "${def.name}": ${err.message}`);
    }
  }
  return tools;
}

function normalizeConfigPath(path) {
  if (typeof path !== 'string' || !path.trim()) return undefined;
  if (path.startsWith('$.')) return path;
  if (path.startsWith('$')) return `$.${path.slice(1)}`;
  return `$.${path}`;
}

export function registerScriptContract(registry) {
  registry.register('lcod://tooling/script@1', async (ctx, input = {}) => {
    const language = input.language || 'javascript';
    if (language !== 'javascript') {
      throw new Error(`Unsupported scripting language: ${language}`);
    }
    const source = input.source;
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error('Script source must be a non-empty string');
    }

    const timeout = typeof input.timeoutMs === 'number' ? Math.max(1, input.timeoutMs) : 1000;

    const initialState = input.input && typeof input.input === 'object' && !Array.isArray(input.input)
      ? deepClone(input.input)
      : (typeof input.input === 'undefined' ? {} : input.input);

    registerStreams(ctx, initialState, input.streams);

    const bindings = buildBindings(initialState, input.bindings);
    const scope = {
      input: bindings,
      state: deepClone(initialState),
      meta: deepClone(input.meta || {})
    };

    const config = deepClone(input.config || {});

    const messages = [];

    const sandbox = {
      console: {
        log: (...vals) => messages.push(vals.map(v => (typeof v === 'string' ? v : inspect(v))).join(' '))
      }
    };
    vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

    const tools = buildTools(input.tools, sandbox, timeout);

    const api = {
      call: async (id, args) => ctx.call(id, args ?? {}),
      runSlot: async (name, state, slotVars) => {
        if (typeof ctx.runSlot !== 'function') {
          throw new Error('runSlot is not available in this context');
        }
        return ctx.runSlot(name, state ?? {}, slotVars ?? {});
      },
      log: (...values) => {
        messages.push(values.map(v => (typeof v === 'string' ? v : inspect(v))).join(' '));
      },
      config: (path, fallback) => {
        if (path == null) return deepClone(config);
        if (typeof path !== 'string') {
          throw new Error('api.config path must be a string');
        }
        const resolvedPath = normalizeConfigPath(path);
        if (!resolvedPath) return deepClone(config);
        const resolved = resolvePath(config, resolvedPath);
        if (typeof resolved === 'undefined') {
          return typeof fallback === 'undefined' ? undefined : deepClone(fallback);
        }
        return deepClone(resolved);
      },
      run: async (name, payload = {}, options = {}) => {
        const tool = tools.get(name);
        if (!tool) {
          throw new Error(`Unknown tool: ${name}`);
        }
        const clonedPayload = deepClone(payload);
        const result = tool.fn(clonedPayload, api);
        return result && typeof result.then === 'function' ? await result : result;
      }
    };

    let userFn;
    try {
      userFn = compileFunction(source, sandbox, timeout);
    } catch (err) {
      throw new Error(`Failed to compile script: ${err.message}`);
    }

    try {
      const result = await userFn(scope, api);
      if (messages.length && result && typeof result === 'object') {
        const cloned = Array.isArray(result) ? [...result] : { ...result };
        if (!cloned.messages) cloned.messages = [];
        cloned.messages = cloned.messages.concat(messages);
        return cloned;
      }
      if (messages.length) {
        return { result, messages }; // fallback
      }
      return result;
    } catch (err) {
      return {
        success: false,
        messages: [err?.message || String(err)],
        error: err?.stack
      };
    }
  });

  return registry;
}
