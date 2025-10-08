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

export async function runSteps(ctx, steps, state, slot) {
  const base = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
  let cur = { ...base };
  for (const step of steps || []) {
    const children = Array.isArray(step.children)
      ? { children: step.children }
      : (step.children || null);

    const prevRunChildren = ctx.runChildren;
    const prevRunSlot = ctx.runSlot;
    ctx.runChildren = async (childrenArray, localState, slotVars) => {
      const baseState = localState == null ? cur : localState;
      ctx._pushScope();
      try {
        return await runSteps(ctx, childrenArray || [], baseState, slotVars ?? slot);
      }
      finally { await ctx._popScope(); }
    };
    ctx.runSlot = async (name, localState, slotVars) => {
      const arr = (children && (children[name] || (name === 'children' ? children.children : null))) || [];
      const baseState = localState == null ? cur : localState;
      ctx._pushScope();
      try {
        return await runSteps(ctx, arr, baseState, slotVars ?? slot);
      }
      finally { await ctx._popScope(); }
    };

    const input = buildInput(step.in || {}, cur, slot);
    ctx._pushScope();
   let res;
   try { res = await ctx.call(step.call, input, { children, slot, collectPath: step.collectPath }); }
    finally {
      await ctx._popScope();
      ctx.runChildren = prevRunChildren;
      ctx.runSlot = prevRunSlot;
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
  }
  return cur;
}
