function buildErrorValue(error) {
  if (!error) return { message: 'Unknown slot error', code: 'slot_execution_failed' };
  if (typeof error === 'object') {
    return {
      message: error.message || String(error),
      code: error.code || 'slot_execution_failed'
    };
  }
  return {
    message: String(error),
    code: 'slot_execution_failed'
  };
}

function isSlotMissing(error) {
  if (!error) return false;
  if (error.code === 'slot_not_found') return true;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return message.includes('slot "') && message.includes('" not provided');
}

export async function composeRunSlot(ctx, input = {}, meta) {
  const slot = typeof input.slot === 'string' && input.slot.trim().length
    ? input.slot.trim()
    : null;
  if (!slot) {
    throw new Error('slot must be provided');
  }
  const optional = Boolean(input.optional);
  try {
    const result = await ctx.runSlot(slot, input.state ?? null, input.slotVars ?? null);
    return { ran: true, result };
  } catch (error) {
    if (optional && isSlotMissing(error)) {
      return { ran: false, result: null };
    }
    return { ran: true, error: buildErrorValue(error) };
  }
}
