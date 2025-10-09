function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function registerRegistryScope(registry) {
  registry.register('lcod://tooling/registry/scope@1', async (ctx, input = {}, meta = {}) => {
    const sanitizedBindings = {};
    if (isPlainObject(input.bindings)) {
      for (const [contractId, implementationId] of Object.entries(input.bindings)) {
        if (typeof contractId === 'string' && typeof implementationId === 'string') {
          sanitizedBindings[contractId] = implementationId;
        }
      }
    }

    const hasBindings = Object.keys(sanitizedBindings).length > 0;
    ctx.enterRegistryScope({
      bindings: hasBindings ? sanitizedBindings : undefined
    });

    if (Array.isArray(input.components) && input.components.length > 0) {
      console.warn('tooling/registry/scope@1: `components` are not yet supported by the Node kernel; ignoring.');
    }

    try {
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
