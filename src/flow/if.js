export async function flowIf(ctx, input, meta) {
  const cond = !!(input && input.cond);
  const branchState = await ctx.runSlot(cond ? 'then' : 'else');
  return branchState ?? {};
}
