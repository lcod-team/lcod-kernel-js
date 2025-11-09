export async function flowIf(ctx, input, meta) {
  const cond = !!(input && input.cond);
  const slotName = cond ? 'then' : 'else';
  try {
    const branchState = await ctx.runSlot(slotName);
    return branchState ?? {};
  } catch (err) {
    if (slotName === 'else' && isSlotMissingError(err)) {
      return {};
    }
    throw err;
  }
}

function isSlotMissingError(error) {
  if (!error) return false;
  const msg = error?.message;
  return typeof msg === 'string' && msg.includes('Slot "') && msg.includes('not provided');
}
