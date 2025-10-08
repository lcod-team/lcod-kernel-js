import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCompose } from '../src/compose/normalizer.js';

test('normalizeCompose expands identity inputs and outputs', async () => {
  const compose = [
    {
      call: 'lcod://impl/echo@1',
      in: {
        foo: '=',
        nested: { path: '=' }
      },
      out: {
        bar: '='
      }
    }
  ];

  const normalized = await normalizeCompose(compose);
  assert.equal(normalized[0].in.foo, '$.foo');
  assert.equal(normalized[0].in.nested.path, '=');
  assert.equal(normalized[0].out.bar, 'bar');
});

test('normalizeCompose processes children recursively', async () => {
  const compose = [
    {
      call: 'lcod://flow/if@1',
      in: {
        cond: '='
      },
      children: {
        then: [
          {
            call: 'lcod://impl/echo@1',
            in: { value: '=' },
            out: { result: '=' }
          }
        ]
      }
    }
  ];

  const normalized = await normalizeCompose(compose);
  const step = normalized[0];
  assert.equal(step.in.cond, '$.cond');
  assert.equal(step.children.then[0].in.value, '$.value');
  assert.equal(step.children.then[0].out.result, 'result');
});

test('normalizeCompose supports spreads and optional mappings', async () => {
  const compose = [
    {
      call: 'lcod://impl/echo@1',
      in: {
        '...': '$.payload',
        '...lock': '=',
        'configPath?': '=',
        required: '='
      },
      out: {
        result: '='
      }
    }
  ];

  const normalized = await normalizeCompose(compose);
  const step = normalized[0];
  assert.ok(Array.isArray(step.in.__lcod_spreads__));
  assert.equal(step.in.__lcod_spreads__.length, 2);
  assert.equal(step.in.__lcod_spreads__[0].source, '$.payload');
  assert.equal(step.in.__lcod_spreads__[1].source, '$.lock');
  assert.equal(step.in.configPath.__lcod_optional__, true);
  assert.equal(step.in.configPath.value, '$.configPath');
  assert.equal(step.in.required, '$.required');
  assert.equal(step.out.result, 'result');
});
