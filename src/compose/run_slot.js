function slotExists(meta, name) {
  if (!meta || typeof meta !== 'object') return false;
  const children = meta?.children;
  if (!children || typeof children !== 'object') return false;
  const slot = children[name];
  return Array.isArray(slot) && slot.length > 0;
}

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

export async function composeRunSlot(ctx, input = {}, meta) {
  const slot = typeof input.slot === 'string' && input.slot.trim().length
    ? input.slot.trim()
    : null;
  if (!slot) {
    throw new Error('slot must be provided');
  }
  const optional = Boolean(input.optional);
  if (optional && !slotExists(meta, slot)) {
    return { ran: false, result: null };
  }
  try {
    const result = await ctx.runSlot(slot, input.state ?? null, input.slotVars ?? null);
    return { ran: true, result };
  } catch (error) {
    return { ran: true, error: buildErrorValue(error) };
  }
}
