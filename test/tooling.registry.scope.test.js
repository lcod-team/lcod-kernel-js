import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry, Context } from '../src/registry.js';
import { runCompose } from '../src/compose.js';
import { registerTooling } from '../src/tooling/index.js';

function setupRegistry() {
  const registry = new Registry();
  registerTooling(registry);

  registry.register('lcod://impl/demo/base@1', async () => ({ result: 'base' }));
  registry.register('lcod://impl/demo/scoped@1', async () => ({ result: 'scoped' }));
  registry.register('lcod://impl/demo/error@1', async () => {
    throw new Error('boom');
  });
  registry.register('lcod://helper/register-scoped@1', async (ctx) => {
    ctx.registry.register('lcod://helper/scoped-temp@1', async () => ({ result: 'scoped-helper' }));
    return {};
  });
  registry.setBindings({
    'lcod://contract/demo/value@1': 'lcod://impl/demo/base@1'
  });

  return registry;
}

test('registry scope applies temporary bindings and restores afterwards', async () => {
  const registry = setupRegistry();
  const ctx = new Context(registry);

  const compose = [
    {
      call: 'lcod://tooling/registry/scope@1',
      in: {
        bindings: {
          'lcod://contract/demo/value@1': 'lcod://impl/demo/scoped@1'
        }
      },
      children: [
        {
          call: 'lcod://contract/demo/value@1',
          out: { scopedValue: 'result' }
        }
      ],
      out: {
        scoped: 'scopedValue'
      }
    },
    {
      call: 'lcod://contract/demo/value@1',
      out: { global: 'result' }
    }
  ];

  const result = await runCompose(ctx, compose, {});
  assert.equal(result.scoped, 'scoped');
  assert.equal(result.global, 'base');
});

test('registry scope restores bindings even when children fail', async () => {
  const registry = setupRegistry();
  const ctx = new Context(registry);

  const failingCompose = [
    {
      call: 'lcod://tooling/registry/scope@1',
      in: {
        bindings: {
          'lcod://contract/demo/value@1': 'lcod://impl/demo/error@1'
        }
      },
      children: [
        {
          call: 'lcod://contract/demo/value@1'
        }
      ]
    }
  ];

  await assert.rejects(() => runCompose(ctx, failingCompose, {}), /boom/);

  const verifyCompose = [
    {
      call: 'lcod://contract/demo/value@1',
      out: { value: 'result' }
    }
  ];

  const verification = await runCompose(ctx, verifyCompose, {});
  assert.equal(verification.value, 'base');
});

test('registry scope isolates helper registrations', async () => {
  const registry = setupRegistry();
  const ctx = new Context(registry);

  const compose = [
    {
      call: 'lcod://tooling/registry/scope@1',
      children: [
        { call: 'lcod://helper/register-scoped@1' },
        {
          call: 'lcod://helper/scoped-temp@1',
          out: { scoped: 'result' }
        }
      ],
      out: { scopeResult: 'scoped' }
    }
  ];

  const result = await runCompose(ctx, compose, {});
  assert.equal(result.scopeResult, 'scoped-helper');

  assert.equal(registry.get('lcod://helper/scoped-temp@1'), undefined);
  await assert.rejects(() => ctx.call('lcod://helper/scoped-temp@1', {}), /Func not found/);
});

test('registry scope registers inline components for the duration of the scope', async () => {
  const registry = setupRegistry();
  const ctx = new Context(registry);

  const compose = [
    {
      call: 'lcod://tooling/registry/scope@1',
      in: {
        components: [
          {
            id: 'lcod://helper/inline-temp@1',
            compose: [
              {
                call: 'lcod://impl/demo/scoped@1',
                out: { value: 'result' }
              }
            ]
          }
        ]
      },
      children: [
        {
          call: 'lcod://helper/inline-temp@1',
          out: { scopedValue: 'value' }
        }
      ],
      out: { scoped: 'scopedValue' }
    }
  ];

  const result = await runCompose(ctx, compose, {});
  assert.equal(result.scoped, 'scoped');

  assert.equal(registry.get('lcod://helper/inline-temp@1'), undefined);
  await assert.rejects(() => ctx.call('lcod://helper/inline-temp@1', {}), /Func not found/);
});
