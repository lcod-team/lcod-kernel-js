import { logKernelError, logKernelInfo } from '../tooling/logging.js';

const SPREAD_KEY = '__lcod_spreads__';
const OPTIONAL_FLAG = '__lcod_optional__';

function getByPathRoot(rootObj, pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return pathStr;
  const parts = pathStr.split('.');
  let cur = rootObj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function isStepDefinition(value) {
  return Boolean(value && typeof value === 'object' && typeof value.call === 'string');
}

function cloneLiteral(value) {
  if (Array.isArray(value)) {
    return value.map(cloneLiteral);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneLiteral(v);
    }
    return out;
  }
  return value;
}

function resolveValue(v, state, slot) {
  if (Array.isArray(v)) {
    return v.map(item => (isStepDefinition(item) ? item : resolveValue(item, state, slot)));
  }
  if (v && typeof v === 'object') {
    if (v[OPTIONAL_FLAG]) {
      return resolveValue(v.value, state, slot);
    }
    if (isStepDefinition(v)) return v;
    const out = {};
    for (const [key, value] of Object.entries(v)) {
      if (key === 'bindings') {
        out[key] = cloneLiteral(value);
      } else {
        out[key] = resolveValue(value, state, slot);
      }
    }
    return out;
  }
  if (typeof v !== 'string') return v;
  if (v === '__lcod_state__') return cloneLiteral(state);
  if (v === '__lcod_result__') return null;
  if (v.startsWith('$.')) return getByPathRoot({ $: state }, v);
  if (v.startsWith('$slot.')) return getByPathRoot({ $slot: slot || {} }, v);
  return v;
}

function buildInput(bindings, state, slot) {
  const out = {};
  const spreadDescriptors = Array.isArray(bindings?.[SPREAD_KEY]) ? bindings[SPREAD_KEY] : null;
  if (spreadDescriptors) {
    for (const descriptor of spreadDescriptors) {
      if (!descriptor || typeof descriptor !== 'object') continue;
      const source = resolveValue(descriptor.source, state, slot);
      if (source == null || typeof source !== 'object' || Array.isArray(source)) {
        if (descriptor.optional) continue;
        continue;
      }
      if (Array.isArray(descriptor.pick)) {
        for (const key of descriptor.pick) {
          if (Object.prototype.hasOwnProperty.call(source, key)) {
            out[key] = cloneLiteral(source[key]);
          } else if (!descriptor.optional) {
            out[key] = undefined;
          }
        }
      } else {
        for (const [key, value] of Object.entries(source)) {
          out[key] = cloneLiteral(value);
        }
      }
    }
  }
  for (const [k, rawValue] of Object.entries(bindings || {})) {
    if (k === SPREAD_KEY) continue;
    if (k === 'bindings') {
      out[k] = cloneLiteral(rawValue);
      continue;
    }
    let optional = false;
    let value = rawValue;
    if (value && typeof value === 'object' && value[OPTIONAL_FLAG]) {
      optional = true;
      value = value.value;
    }
    const resolved = resolveValue(value, state, slot);
    if (optional && (resolved === undefined || resolved === null)) {
      continue;
    }
    out[k] = resolved;
  }
  return out;
}

function composeStepTags(step) {
  const tags = { logger: 'kernel.compose.step' };
  if (step && typeof step.call === 'string' && step.call.length > 0) {
    tags.componentId = step.call;
  }
  return tags;
}

function cleanPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function nonEmptyKeys(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const keys = Object.keys(candidate);
  return keys.length > 0 ? keys : undefined;
}

function stepHasChildren(step) {
  if (!step || !step.children) return false;
  if (Array.isArray(step.children)) {
    return step.children.length > 0;
  }
  if (typeof step.children === 'object') {
    return Object.values(step.children).some(value => Array.isArray(value) && value.length > 0);
  }
  return false;
}

function buildStartData(index, step, inputKeys, slotKeys, hasChildren) {
  return cleanPayload({
    phase: 'start',
    stepIndex: index,
    collectPath: step?.collectPath,
    inputKeys,
    slotKeys,
    hasChildren: hasChildren ? true : undefined
  });
}

function describeResultType(result) {
  if (result === null || result === undefined) return 'null';
  if (Array.isArray(result)) return 'array';
  const type = typeof result;
  if (type === 'object') return 'object';
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  return type;
}

function buildSuccessData(index, durationMs, result) {
  const payload = {
    phase: 'success',
    stepIndex: index,
    durationMs,
    resultType: describeResultType(result)
  };
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const keys = Object.keys(result);
    if (keys.length > 0) {
      payload.resultKeys = keys;
    }
  } else if (Array.isArray(result)) {
    payload.resultLength = result.length;
  }
  return cleanPayload(payload);
}

function buildErrorData(index, durationMs, error) {
  const errorInfo = cleanPayload({
    message: error?.message ?? String(error),
    type: error?.name
  });
  return cleanPayload({
    phase: 'error',
    stepIndex: index,
    durationMs,
    error: errorInfo
  });
}

export async function runSteps(ctx, steps, state, slot) {
  const base = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
  let cur = { ...base };
  const list = Array.isArray(steps) ? steps : [];
  for (let index = 0; index < list.length; index += 1) {
    ctx.ensureNotCancelled();
    const step = list[index];
    const children = Array.isArray(step.children)
      ? { children: step.children }
      : (step.children || null);

    const prevRunChildren = ctx.runChildren;
    const prevRunSlot = ctx.runSlot;
    ctx.runChildren = async (childrenArray, localState, slotVars) => {
      ctx.ensureNotCancelled();
      const baseState = localState == null ? cur : localState;
      ctx._pushScope();
      try {
        return await runSteps(ctx, childrenArray || [], baseState, slotVars ?? slot);
      } finally {
        await ctx._popScope();
      }
    };
    ctx.runSlot = async (name, localState, slotVars) => {
      ctx.ensureNotCancelled();
      const arr = (children && (children[name] || (name === 'children' ? children.children : null))) || [];
      const baseState = localState == null ? cur : localState;
      ctx._pushScope();
      try {
        return await runSteps(ctx, arr, baseState, slotVars ?? slot);
      } finally {
        await ctx._popScope();
      }
    };

    const input = buildInput(step.in || {}, cur, slot);
    const startPayload = buildStartData(
      index,
      step,
      nonEmptyKeys(input),
      nonEmptyKeys(slot),
      stepHasChildren(step)
    );
    try {
      await logKernelInfo(ctx, 'compose.step', {
        tags: composeStepTags(step),
        data: startPayload
      });
    } catch (_) {
      // ignore logging failures
    }

    const startTime = process.hrtime.bigint();
    ctx._pushScope();
    let res;
    let callError;
    try {
      res = await ctx.call(step.call, input, { children, slot, collectPath: step.collectPath });
    } catch (error) {
      callError = error;
    } finally {
      await ctx._popScope();
      ctx.runChildren = prevRunChildren;
      ctx.runSlot = prevRunSlot;
    }

    const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;

    if (callError) {
      const errorPayload = buildErrorData(index, durationMs, callError);
      try {
        await logKernelError(ctx, 'compose.step', {
          tags: composeStepTags(step),
          data: errorPayload
        });
      } catch (_) {
        // ignore logging failures
      }
      throw callError;
    }

    const spreadsOut = Array.isArray(step.out?.[SPREAD_KEY]) ? step.out[SPREAD_KEY] : null;
    if (spreadsOut && res && typeof res === 'object') {
      for (const descriptor of spreadsOut) {
        if (!descriptor || typeof descriptor !== 'object') continue;
        const sourceValue = descriptor.source;
        let payload;
        if (typeof sourceValue === 'string' && sourceValue === '$') {
          payload = res;
        } else if (sourceValue === '__lcod_result__') {
          payload = res;
        } else if (typeof sourceValue === 'string' && sourceValue.startsWith('$.')) {
          payload = getByPathRoot({ $: res }, sourceValue);
        } else {
          payload = res;
        }
        if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
          if (descriptor.optional) continue;
          continue;
        }
        if (Array.isArray(descriptor.pick)) {
          for (const key of descriptor.pick) {
            if (Object.prototype.hasOwnProperty.call(payload, key)) {
              cur[key] = cloneLiteral(payload[key]);
            } else if (!descriptor.optional) {
              cur[key] = undefined;
            }
          }
        } else {
          for (const [key, value] of Object.entries(payload)) {
            cur[key] = cloneLiteral(value);
          }
        }
      }
    }
    for (const [alias, rawValue] of Object.entries(step.out || {})) {
      if (alias === SPREAD_KEY) continue;
      let optional = false;
      let key = rawValue;
      if (key && typeof key === 'object' && key[OPTIONAL_FLAG]) {
        optional = true;
        key = key.value;
      }
      let resolved;
      if (key === '$') {
        resolved = res;
      } else {
        resolved = res?.[key];
      }
      if (optional && (resolved === undefined || resolved === null)) {
        continue;
      }
      cur[alias] = resolved;
    }

    const successPayload = buildSuccessData(index, durationMs, res);
    try {
      await logKernelInfo(ctx, 'compose.step', {
        tags: composeStepTags(step),
        data: successPayload
      });
    } catch (_) {
      // ignore logging failures
    }
  }
  return cur;
}
