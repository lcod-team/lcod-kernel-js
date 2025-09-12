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

function depsForStep(step) {
  const deps = new Set();
  for (const v of Object.values(step.in || {})) {
    if (typeof v === 'string' && v.startsWith('$.')) {
      const key = v.slice(2).split('.')[0];
      deps.add(key);
    }
  }
  return deps;
}

export async function runCompose(ctx, compose, initialState = {}) {
  let state = { ...initialState };
  const steps = (compose || []).map((s, idx) => ({ idx, s, deps: depsForStep(s), produces: new Set(Object.keys(s.out || {})), done: false }));
  const produced = new Set(Object.keys(state));
  let remaining = steps.length;

  while (remaining > 0) {
    const batch = [];
    for (const st of steps) {
      if (st.done) continue;
      let ready = true;
      for (const d of st.deps) if (!produced.has(d)) { ready = false; break; }
      if (ready) batch.push(st);
    }
    if (batch.length === 0) {
      throw new Error('Compose deadlock: unresolved dependencies or cycle');
    }
    const aliases = new Set();
    for (const st of batch) {
      for (const a of st.produces) {
        if (aliases.has(a)) throw new Error(`Alias collision in compose batch: ${a}`);
        aliases.add(a);
      }
    }
    const results = await Promise.all(batch.map(async (st) => {
      const input = buildInput(st.s.in || {}, state);
      const res = await ctx.call(st.s.call, input);
      return { st, res };
    }));
    for (const { st, res } of results) {
      for (const [alias, key] of Object.entries(st.s.out || {})) {
        state[alias] = res[key];
        produced.add(alias);
      }
      st.done = true; remaining--;
    }
  }
  return state;
}
