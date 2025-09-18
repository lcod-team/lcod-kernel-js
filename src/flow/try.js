import { normalizeError } from './utils.js';

function hasSlot(meta, name) {
  return Boolean(meta?.children && Array.isArray(meta.children[name]) && meta.children[name].length);
}

export async function flowTry(ctx, _input = {}, meta = {}) {
  let resultState = {};
  let pendingError = null;

  try {
    resultState = await ctx.runSlot('children', undefined, { phase: 'try' }) || {};
  } catch (err) {
    pendingError = normalizeError(err);
    if (hasSlot(meta, 'catch')) {
      try {
        resultState = await ctx.runSlot('catch', undefined, { error: pendingError, phase: 'catch' }) || {};
        pendingError = null;
      } catch (catchErr) {
        pendingError = normalizeError(catchErr);
      }
    }
  } finally {
    if (hasSlot(meta, 'finally')) {
      const finallyState = await ctx.runSlot('finally', undefined, { phase: 'finally', error: pendingError }) || {};
      resultState = { ...resultState, ...finallyState };
    }
  }

  if (pendingError) {
    throw pendingError;
  }

  return resultState;
}
