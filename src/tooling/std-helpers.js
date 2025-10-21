import { createHash } from 'node:crypto';

const visitedKeyPrefix = 'item:';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clonePlainObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function normaliseObject(value) {
  return isPlainObject(value) ? value : {};
}

function normalisePath(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalise(value, stack) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (stack.has(value)) {
    throw new TypeError('Cannot stringify cyclic structures');
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalise(entry, stack));
    }
    const ordered = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      ordered[key] = canonicalise(value[key], stack);
    }
    return ordered;
  } finally {
    stack.delete(value);
  }
}

function stableStringify(value) {
  const canonical = canonicalise(value, new WeakSet());
  return JSON.stringify(canonical);
}

function createHashKey(text, prefix) {
  const digest = createHash('sha256').update(text, 'utf8').digest('base64');
  return prefix ? `${prefix}${digest}` : digest;
}

function appendChildren(queue, children) {
  if (!Array.isArray(children)) return;
  for (const child of children) {
    queue.push(child);
  }
}

function collectWarnings(target, warnings) {
  if (!Array.isArray(warnings)) return;
  for (const warning of warnings) {
    if (typeof warning === 'string' && warning.length > 0) {
      target.push(warning);
    }
  }
}

export function registerStdHelpers(registry) {
  registry.register('lcod://tooling/object/clone@0.1.0', async (_ctx, input = {}) => {
    if (!isPlainObject(input.value)) {
      return { clone: {} };
    }
    return { clone: clonePlainObject(input.value) };
  });

  registry.register('lcod://tooling/object/set@0.1.0', async (_ctx, input = {}) => {
    const target = normaliseObject(input.target);
    const updated = clonePlainObject(target);
    const previous = target;
    const path = normalisePath(input.path);

    if (path.length === 0) {
      return { object: input.value, previous };
    }

    let cursor = updated;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i];
      if (typeof segment !== 'string' || segment.length === 0) {
        continue;
      }
      if (!isPlainObject(cursor[segment])) {
        cursor[segment] = {};
      }
      cursor = cursor[segment];
    }

    const lastKey = path[path.length - 1];
    if (typeof lastKey === 'string' && lastKey.length > 0) {
      cursor[lastKey] = input.value;
    }

    return { object: updated, previous };
  });

  registry.register('lcod://tooling/object/has@0.1.0', async (_ctx, input = {}) => {
    const target = normaliseObject(input.target);
    const path = normalisePath(input.path);
    if (path.length === 0) {
      return { hasKey: false, value: undefined };
    }

    let cursor = target;
    for (let i = 0; i < path.length; i += 1) {
      const segment = path[i];
      if (typeof segment !== 'string' || segment.length === 0) {
        return { hasKey: false, value: undefined };
      }
      if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
        return { hasKey: false, value: undefined };
      }
      const next = cursor[segment];
      if (i === path.length - 1) {
        return { hasKey: true, value: next };
      }
      if (!isPlainObject(next)) {
        return { hasKey: false, value: undefined };
      }
      cursor = next;
    }
    return { hasKey: false, value: undefined };
  });

  registry.register('lcod://tooling/json/stable_stringify@0.1.0', async (_ctx, input = {}) => {
    try {
      const text = stableStringify(input.value);
      return { text, warning: null };
    } catch (err) {
      return { text: null, warning: err?.message || String(err) };
    }
  });

  registry.register('lcod://tooling/hash/to_key@0.1.0', async (_ctx, input = {}) => {
    const text = typeof input.text === 'string' ? input.text : '';
    const prefix = typeof input.prefix === 'string' ? input.prefix : '';
    const key = createHashKey(text, prefix);
    return { key };
  });

  registry.register('lcod://tooling/queue/bfs@0.1.0', async (ctx, input = {}) => {
    const queue = Array.isArray(input.items) ? [...input.items] : [];
    const visitedMap = isPlainObject(input.visited) ? { ...input.visited } : {};
    const visited = new Set(Object.keys(visitedMap));
    let state = isPlainObject(input.state) ? { ...input.state } : {};
    const contextValue = Object.prototype.hasOwnProperty.call(input, 'context') ? input.context : undefined;

    const maxIterations = Number.isFinite(input.maxIterations) && input.maxIterations > 0
      ? Math.trunc(input.maxIterations)
      : Number.POSITIVE_INFINITY;

    const warnings = [];
    let iterations = 0;

    while (queue.length > 0) {
      ctx.ensureNotCancelled();
      if (iterations >= maxIterations) {
        throw new Error(`queue/bfs exceeded maxIterations (${maxIterations})`);
      }

      const item = queue.shift();
      const slotVars = {
        index: iterations,
        remaining: queue.length,
        visitedCount: visited.size
      };

      let keyValue = null;
      if (typeof ctx.runSlot === 'function') {
        try {
          const candidate = await ctx.runSlot(
            'key',
            { item, state, context: contextValue },
            slotVars
          );
          if (typeof candidate === 'string' && candidate.length > 0) {
            keyValue = candidate;
          }
        } catch (err) {
          warnings.push(`queue/bfs key slot failed: ${err?.message || String(err)}`);
        }
      }

      if (!keyValue) {
        try {
          keyValue = JSON.stringify(item);
        } catch (err) {
          warnings.push(`queue/bfs fallback key serialization failed: ${err?.message || String(err)}`);
          keyValue = `${visitedKeyPrefix}${iterations}`;
        }
      }

      if (visited.has(keyValue)) {
        iterations += 1;
        continue;
      }
      visited.add(keyValue);
      visitedMap[keyValue] = true;

      let processResult = {};
      if (typeof ctx.runSlot === 'function') {
        const result = await ctx.runSlot(
          'process',
          { item, state, context: contextValue },
          slotVars
        );
        if (result && typeof result === 'object') {
          processResult = result;
        }
      }

      appendChildren(queue, processResult.children);
      if (isPlainObject(processResult.state)) {
        state = processResult.state;
      }
      collectWarnings(warnings, processResult.warnings);

      iterations += 1;
    }

    return {
      state,
      visited: visitedMap,
      warnings,
      iterations
    };
  });
}
