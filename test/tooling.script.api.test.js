import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry, Context } from '../src/registry.js';
import { registerScriptContract } from '../src/tooling/script.js';
import { LOG_CONTRACT_ID } from '../src/tooling/logging.js';

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

test('console methods forward to logging contract', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);
  const captured = [];

  registry.register(LOG_CONTRACT_ID, async (_ctx, payload = {}) => {
    captured.push(payload);
    return payload;
  });

  const request = {
    source: `async () => {
      console.log('hello world');
      console.warn('warned', { code: 123 });
      return { done: true };
    }`
  };

  const result = await ctx.call('lcod://tooling/script@1', request, null);

  assert.equal(result.done, true);
  const messages = result.messages || [];
  assert.ok(messages.some(msg => msg.includes('hello world')));

  assert.equal(captured.length, 2);
  assert.equal(captured[0].level, 'info');
  assert.equal(captured[0].message, 'hello world');
  assert.equal(captured[1].level, 'warn');
  assert.ok(captured[1].message.includes('warned'));
  assert.ok(captured[1].message.includes('123'));
});
