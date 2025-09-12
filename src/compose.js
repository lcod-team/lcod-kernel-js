// Minimal compose runner (sequential). Supports $.path bindings and explicit out mapping.

function getByPath(obj, path) {
  if (!path || !path.startsWith('$.')) return path;
  const parts = path.slice(2).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function buildInput(bindings, state) {
  const out = {};
  for (const [k, v] of Object.entries(bindings || {})) {
    if (typeof v === 'string' && v.startsWith('$.')) out[k] = getByPath(state, v);
    else out[k] = v;
  }
  return out;
}

export async function runCompose(ctx, compose, initialState = {}) {
  let state = { ...initialState };
  for (const step of compose || []) {
    const input = buildInput(step.in || {}, state);
    const res = await ctx.call(step.call, input);
    // project outputs
    for (const [alias, key] of Object.entries(step.out || {})) {
      state[alias] = res[key];
    }
  }
  return state;
}

