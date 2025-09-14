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
    const iterState = await ctx.runSlot('body', undefined, { item, index });
    if (meta && meta.collectPath) {
      const val = getByPathRoot({ $: iterState }, meta.collectPath);
      results.push(val);
    }
  }
  return { results };
}

