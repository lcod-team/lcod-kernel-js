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
  let cur = { ...state };
  for (const step of steps || []) {
    // Normalize single-slot children shorthand (children: [...])
    const children = Array.isArray(step.children)
      ? { children: step.children }
      : (step.children || null);

    // Flow: foreach (array)
    if (step.call === 'lcod://flow/foreach@1') {
      const input = buildInput(step.in || {}, cur, slot);
      const list = input.list || [];
      const body = children?.body || children?.children || [];
      const elseSlot = children?.else || [];
      const results = [];
      if (Array.isArray(list) && list.length > 0) {
        for (let index = 0; index < list.length; index++) {
          const item = list[index];
          const iterState = await runSteps(ctx, body, { ...cur }, { ...(slot||{}), item, index });
          const collectPath = step.collectPath;
          if (collectPath) {
            const val = resolveValue(collectPath, iterState, { ...(slot||{}), item, index });
            results.push(val);
          }
        }
      } else {
        cur = await runSteps(ctx, elseSlot, cur, slot);
      }
      for (const [alias, key] of Object.entries(step.out || {})) {
        if (key === 'results') cur[alias] = results;
      }
      continue;
    }

    // Flow: if
    if (step.call === 'lcod://flow/if@1') {
      const input = buildInput(step.in || {}, cur, slot);
      const cond = !!input.cond;
      const thenSteps = children?.then || children?.children || [];
      const elseSteps = children?.else || [];
      cur = await runSteps(ctx, cond ? thenSteps : elseSteps, cur, slot);
      continue;
    }

    // Regular call
    const input = buildInput(step.in || {}, cur, slot);
    const res = await ctx.call(step.call, input);
    for (const [alias, key] of Object.entries(step.out || {})) {
      cur[alias] = res[key];
    }
  }
  return cur;
}

export async function runCompose(ctx, compose, initialState = {}) {
  return runSteps(ctx, compose || [], initialState, {});
}
