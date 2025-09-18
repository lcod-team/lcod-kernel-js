import { getByPath, normalizeError } from './utils.js';

function hasSlot(meta, name) {
  return Boolean(meta?.children && Array.isArray(meta.children[name]) && meta.children[name].length);
}

export async function flowParallel(ctx, input = {}, meta = {}) {
  const items = Array.isArray(input.tasks) ? input.tasks : [];
  const collectPath = meta.collectPath;
  const hasTasksSlot = hasSlot(meta, 'tasks');
  if (!hasTasksSlot) return { results: [] };

  const results = [];

  for (let index = 0; index < items.length; index++) {
    const slotVars = { item: items[index], index };
    try {
      const iterState = await ctx.runSlot('tasks', undefined, slotVars) || {};
      results[index] = collectPath
        ? getByPath({ $: iterState, $slot: slotVars }, collectPath)
        : iterState;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  return { results };
}

