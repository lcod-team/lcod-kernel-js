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

function resolveValue(v, state, slot) {
  if (typeof v !== 'string') return v;
  if (v.startsWith('$.')) return getByPathRoot({ $: state }, v);
  if (v.startsWith('$slot.')) return getByPathRoot({ $slot: slot || {} }, v);
  return v;
}

function buildInput(bindings, state, slot) {
  const out = {};
  for (const [k, v] of Object.entries(bindings || {})) {
    out[k] = resolveValue(v, state, slot);
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
  return runSteps(ctx, compose || [], seed, {});
}
