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

export async function flowForeach(ctx, input, meta) {
  const list = (input && Array.isArray(input.list)) ? input.list : [];
  const results = [];
  if (list.length === 0) {
    await ctx.runSlot('else');
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
        // console.error('collect', meta.collectPath, '=>', val);
        results.push(val);
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
