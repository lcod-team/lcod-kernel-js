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

async function toArray(maybeIterable) {
  if (!maybeIterable) return [];
  if (Array.isArray(maybeIterable)) return maybeIterable;
  if (typeof maybeIterable[Symbol.asyncIterator] === 'function') {
    const collected = [];
    for await (const item of maybeIterable) collected.push(item);
    return collected;
  }
  if (typeof maybeIterable[Symbol.iterator] === 'function') {
    return [...maybeIterable];
  }
  return [];
}

export async function flowForeach(ctx, input, meta) {
  const list = await toArray(input?.list ?? input?.stream);
  const results = [];
  if (list.length === 0) {
    const elseState = await ctx.runSlot('else', undefined, { item: undefined, index: -1 });
    if (meta && meta.collectPath) {
      const val = getByPathRoot({ $: elseState, $slot: { item: undefined, index: -1 } }, meta.collectPath);
      if (typeof val !== 'undefined') results.push(val);
    }
    return { results };
  }
  for (let index = 0; index < list.length; index++) {
    const item = list[index];
    try {
      const iterState = await ctx.runSlot('body', undefined, { item, index });
      const root = { $: iterState, $slot: { item, index } };
      // debug: uncomment for tracing
      // console.error('foreach iter', { index, item, iterState });
      if (meta && meta.collectPath) {
        const val = getByPathRoot(root, meta.collectPath);
        if (typeof val !== 'undefined') {
          results.push(val);
        }
      } else {
        results.push(item);
      }
    } catch (e) {
      if (e && e.$signal === 'continue') continue;
      if (e && e.$signal === 'break') break;
      throw e;
    }
  }
  return { results };
}
