import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry, Context } from '../src/registry.js';
import { registerScriptContract } from '../src/tooling/script.js';

function createRegistry() {
  const registry = new Registry();
  registerScriptContract(registry);
  registry.register('lcod://impl/echo@1', async (_ctx, input = {}) => ({ val: input.value }));
  return registry;
}

test('tooling/script api.run + api.config', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const request = {
    source: `async ({ input }, api) => {
      const cfg = api.config();
      const doubled = await api.run('double', { value: input.value });
      const guarded = await api.run('guard', doubled);
      return { success: cfg.feature.enabled && guarded.success, result: guarded.value };
    }`,
    bindings: {
      value: { path: '$.payload.value' }
    },
    input: { payload: { value: 5 } },
    config: {
      feature: { enabled: true },
      thresholds: { min: 2 }
    },
    tools: [
      {
        name: 'double',
        source: "({ value }, api) => { api.log('doubling', value); return { success: true, value: value * 2 }; }"
      },
      {
        name: 'guard',
        source: "({ value }, api) => { const min = api.config('thresholds.min', 0); if (value < min) return { success: false }; return { success: true, value }; }"
      }
    ]
  };

  const result = await ctx.call('lcod://tooling/script@1', request, null);

  assert.equal(result.success, true);
  assert.equal(result.result, 10);
  const messages = result.messages || [];
  assert.ok(messages.some(msg => msg.includes('doubling')));
});

test('tooling/script imports aliases call components', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const request = {
    source: `async ({ imports, input }, api) => {
      const echoed = await imports.echo({ value: input.payload });
      const direct = await api.call('lcod://impl/echo@1', { value: echoed.val * 2 });
      return { value: direct.val };
    }`,
    input: { payload: 7 },
    bindings: {
      payload: { path: '$.payload' }
    },
    imports: {
      echo: 'lcod://impl/echo@1'
    }
  };

  const result = await ctx.call('lcod://tooling/script@1', request, null);
  assert.equal(result.value, 14);
});
