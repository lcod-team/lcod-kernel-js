import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry, Context } from '../src/registry.js';
import { registerDemoAxioms } from '../src/axioms.js';
import { runCompose } from '../src/compose.js';
import { flowIf } from '../src/flow/if.js';
import { flowForeach } from '../src/flow/foreach.js';
import { flowBreak } from '../src/flow/break.js';
import { flowContinue } from '../src/flow/continue.js';

function buildDemoContext() {
  const reg = registerDemoAxioms(new Registry());
  reg.register('lcod://flow/if@1', flowIf);
  reg.register('lcod://flow/foreach@1', flowForeach);
  reg.register('lcod://flow/break@1', flowBreak);
  reg.register('lcod://flow/continue@1', flowContinue);
  return new Context(reg);
}

test('foreach collects child output with collectPath', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/foreach@1',
      in: { list: '$.numbers' },
      children: {
        body: [
          { call: 'lcod://impl/echo@1', in: { value: '$slot.item' }, out: { val: 'val' } }
        ]
      },
      collectPath: '$.val',
      out: { results: 'results' }
    }
  ];

  const { results } = await runCompose(ctx, compose, { numbers: [1, 2, 3] });
  assert.deepEqual(results, [1, 2, 3]);
});

test('foreach exposes slot variables in collectPath', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/foreach@1',
      in: { list: '$.numbers' },
      children: { body: [] },
      collectPath: '$slot.index',
      out: { results: 'results' }
    }
  ];

  const { results } = await runCompose(ctx, compose, { numbers: ['a', 'b', 'c'] });
  assert.deepEqual(results, [0, 1, 2]);
});

test('foreach handles continue and break signals', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/foreach@1',
      in: { list: '$.numbers' },
      children: {
        body: [
          { call: 'lcod://impl/is_even@1', in: { value: '$slot.item' }, out: { isEven: 'ok' } },
          { call: 'lcod://flow/if@1', in: { cond: '$.isEven' }, children: { then: [ { call: 'lcod://flow/continue@1' } ] } },
          { call: 'lcod://impl/gt@1', in: { value: '$slot.item', limit: 7 }, out: { tooBig: 'ok' } },
          { call: 'lcod://flow/if@1', in: { cond: '$.tooBig' }, children: { then: [ { call: 'lcod://flow/break@1' } ] } },
          { call: 'lcod://impl/echo@1', in: { value: '$slot.item' }, out: { val: 'val' } }
        ]
      },
      collectPath: '$.val',
      out: { results: 'results' }
    }
  ];

  const { results } = await runCompose(ctx, compose, { numbers: [1, 2, 3, 8, 9] });
  assert.deepEqual(results, [1, 3]);
});
