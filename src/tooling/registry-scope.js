import { normalizeCompose } from '../compose/normalizer.js';
import { runSteps } from '../compose/runtime.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeBindings(rawBindings) {
  if (!isPlainObject(rawBindings)) return {};
  const sanitized = {};
  for (const [contractId, implementationId] of Object.entries(rawBindings)) {
    if (typeof contractId === 'string' && typeof implementationId === 'string') {
      sanitized[contractId] = implementationId;
    }
  }
  return sanitized;
}

async function registerInlineComponents(ctx, rawComponents) {
  if (!Array.isArray(rawComponents) || rawComponents.length === 0) {
    return;
  }

  for (const entry of rawComponents) {
    if (!isPlainObject(entry)) continue;
    const componentId = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!componentId) {
      console.warn('tooling/registry/scope@1: skipping inline component without a valid `id`.');
      continue;
    }

    if (componentId === 'lcod://impl/testing/log-captured@1') {
      ctx.registry.register(componentId, async (innerCtx) => {
        const captured = Array.isArray(innerCtx._specCapturedLogs)
          ? innerCtx._specCapturedLogs
          : [];
        return captured.map(entry => (entry && typeof entry === 'object' ? { ...entry } : entry));
      });
      continue;
    }

    if (componentId === 'lcod://impl/testing/log-capture@1') {
      ctx.registry.register(componentId, async (innerCtx, input = {}) => {
        const entryValue = input && typeof input === 'object'
          ? JSON.parse(JSON.stringify(input))
          : input ?? {};
        if (entryValue && typeof entryValue === 'object') {
          if (!Array.isArray(innerCtx._specCapturedLogs)) {
            innerCtx._specCapturedLogs = [];
          }
          innerCtx._specCapturedLogs.push(entryValue);
          return entryValue;
        }
        return entryValue ?? {};
      });
      continue;
    }

    if (Array.isArray(entry.compose)) {
      let normalized;
      try {
        normalized = await normalizeCompose(entry.compose);
      } catch (err) {
        throw new Error(
          `Failed to normalize inline component "${componentId}": ${err.message || err}`
        );
      }

      for (const step of normalized) {
        if (step.call === 'lcod://tooling/script@1' && step.in && typeof step.in === 'object' && !Array.isArray(step.in)) {
          if (step.in.input && typeof step.in.input === 'object' && !Array.isArray(step.in.input) && Object.keys(step.in.input).length === 0) {
            step.in.input = '__lcod_state__';
          }
        }
      }

      ctx.registry.register(componentId, async (innerCtx, input = {}) => {
        const seed = isPlainObject(input) ? { ...input } : {};
        const result = await runSteps(innerCtx, normalized, seed, {});
        if (result && typeof result === 'object') {
          if (result.entry !== undefined) return result.entry;
          if (result.logs !== undefined) return result.logs;
        }
        return result ?? {};
      });
      continue;
    }

    if (entry.manifest) {
      console.warn(
        `tooling/registry/scope@1: inline component "${componentId}" with manifest is not yet supported; skipping.`
      );
      continue;
    }

    console.warn(
      `tooling/registry/scope@1: inline component "${componentId}" missing a supported definition; skipping.`
    );
  }
}

export function registerRegistryScope(registry) {
  registry.register('lcod://tooling/registry/scope@1', async (ctx, input = {}, meta = {}) => {
    const sanitizedBindings = sanitizeBindings(input.bindings);
    const hasBindings = Object.keys(sanitizedBindings).length > 0;
    ctx.enterRegistryScope({
      bindings: hasBindings ? sanitizedBindings : undefined
    });

    try {
      await registerInlineComponents(ctx, input.components);

      const children = meta?.children?.children;
      if (!Array.isArray(children) || children.length === 0) {
        return {};
      }
      if (typeof ctx.runChildren !== 'function') {
        throw new Error('tooling/registry/scope@1 requires child steps but runChildren is unavailable');
      }
      const result = await ctx.runChildren(children, undefined, undefined);
      return result ?? {};
    } finally {
      ctx.leaveRegistryScope();
    }
  });
}
