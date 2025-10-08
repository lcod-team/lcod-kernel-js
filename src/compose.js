import { normalizeCompose } from './compose/normalizer.js';
import { runSteps } from './compose/runtime.js';

export async function runCompose(ctx, compose, initialState = {}) {
  const seed = (initialState && typeof initialState === 'object' && !Array.isArray(initialState))
    ? { ...initialState }
    : {};
  const normalized = await normalizeCompose(compose || []);
  return runSteps(ctx, normalized, seed, {});
}
