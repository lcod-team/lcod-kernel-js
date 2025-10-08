import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCompose } from '../src/compose/normalizer.js';

test('normalizeCompose expands identity inputs and outputs', () => {
  const compose = [
    {
      call: 'lcod://impl/echo@1',
      in: {
        foo: '-',
        nested: { path: '-' }
      },
      out: {
        bar: '-'
      }
    }
  ];

  const normalized = normalizeCompose(compose);
  assert.equal(normalized[0].in.foo, '$.foo');
  assert.deepEqual(normalized[0].in.nested, { path: '-' });
  assert.equal(normalized[0].out.bar, 'bar');
});

test('normalizeCompose processes children recursively', () => {
  const compose = [
    {
      call: 'lcod://flow/if@1',
      in: {
        cond: '-'
      },
      children: {
        then: [
          {
            call: 'lcod://impl/echo@1',
            in: { value: '-' },
            out: { result: '-' }
          }
        ]
      }
    }
  ];

  const normalized = normalizeCompose(compose);
  const step = normalized[0];
  assert.equal(step.in.cond, '$.cond');
  assert.equal(step.children.then[0].in.value, '$.value');
  assert.equal(step.children.then[0].out.result, 'result');
});
