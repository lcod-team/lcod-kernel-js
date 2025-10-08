import { normalizeCompose } from './compose/normalizer.js';

// Compose runner with basic slots and foreach (array). Sequential for simplicity.

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

function resolveValue(v, state, slot) {
  if (Array.isArray(v)) {
    return v.map(item => (isStepDefinition(item) ? item : resolveValue(item, state, slot)));
  }
  if (v && typeof v === 'object') {
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
  if (v.startsWith('$.')) return getByPathRoot({ $: state }, v);
  if (v.startsWith('$slot.')) return getByPathRoot({ $slot: slot || {} }, v);
  return v;
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

function buildInput(bindings, state, slot) {
  const out = {};
  for (const [k, v] of Object.entries(bindings || {})) {
    out[k] = k === 'bindings' ? cloneLiteral(v) : resolveValue(v, state, slot);
  }
  return out;
}

async function runSteps(ctx, steps, state, slot) {
  const base = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
  let cur = { ...base };
  for (const step of steps || []) {
    // Normalize single-slot children shorthand (children: [...])
    const children = Array.isArray(step.children)
      ? { children: step.children }
      : (step.children || null);

    // Expose helpers so implementations can orchestrate slots with scoped cleanups
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

    // Generic call with meta (children, slot, collectPath hint)
    const input = buildInput(step.in || {}, cur, slot);
    ctx._pushScope();
    let res;
    try { res = await ctx.call(step.call, input, { children, slot, collectPath: step.collectPath }); }
    finally {
      await ctx._popScope();
      // restore helpers for outer steps/iterations
      ctx.runChildren = prevRunChildren;
      ctx.runSlot = prevRunSlot;
    }
    for (const [alias, key] of Object.entries(step.out || {})) {
      if (key === '$') {
        cur[alias] = res;
      } else {
        cur[alias] = res?.[key];
      }
    }
  }
  return cur;
}

export async function runCompose(ctx, compose, initialState = {}) {
  const seed = (initialState && typeof initialState === 'object' && !Array.isArray(initialState))
    ? { ...initialState }
    : {};
  const normalized = normalizeCompose(compose || []);
  return runSteps(ctx, normalized, seed, {});
}
