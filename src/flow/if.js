export async function flowIf(ctx, input, meta) {
  const cond = !!(input && input.cond);
  await ctx.runSlot(cond ? 'then' : 'else');
  return {};
}

