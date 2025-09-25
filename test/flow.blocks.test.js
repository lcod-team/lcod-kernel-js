import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { Registry, Context } from '../src/registry.js';
import { registerDemoAxioms } from '../src/axioms.js';
import { runCompose } from '../src/compose.js';
import { flowIf } from '../src/flow/if.js';
import { flowForeach } from '../src/flow/foreach.js';
import { flowParallel } from '../src/flow/parallel.js';
import { flowTry } from '../src/flow/try.js';
import { flowThrow } from '../src/flow/throw.js';
import { flowBreak } from '../src/flow/break.js';
import { flowContinue } from '../src/flow/continue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readSpecYaml(rel) {
  const candidates = [
    process.env.SPEC_REPO_PATH,
    path.resolve(__dirname, '../../lcod-spec'),
    path.resolve(__dirname, '../lcod-spec'),
    path.resolve(__dirname, 'lcod-spec'),
    path.resolve(__dirname, '../../../lcod-spec'),
  ].filter(Boolean);

  for (const base of candidates) {
    const candidate = path.resolve(base, rel);
    try {
      await fs.access(candidate);
      const yamlText = await fs.readFile(candidate, 'utf8');
      return YAML.parse(yamlText);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }
  }
  throw new Error(`Unable to locate spec fixture: ${rel}`);
}

function buildDemoContext() {
  const reg = registerDemoAxioms(new Registry());
  reg.register('lcod://flow/if@1', flowIf);
  reg.register('lcod://flow/foreach@1', flowForeach);
  reg.register('lcod://flow/parallel@1', flowParallel);
  reg.register('lcod://flow/try@1', flowTry);
  reg.register('lcod://flow/throw@1', flowThrow);
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

test('foreach executes else slot when list is empty', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/foreach@1',
      in: { list: '$.numbers' },
      children: {
        body: [
          { call: 'lcod://impl/echo@1', in: { value: '$slot.item' }, out: { val: 'val' } }
        ],
        else: [
          { call: 'lcod://impl/echo@1', in: { value: 'empty' }, out: { val: 'val' } }
        ]
      },
      collectPath: '$.val',
      out: { results: 'results' }
    }
  ];

  const { results } = await runCompose(ctx, compose, { numbers: [] });
  assert.deepEqual(results, ['empty']);
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

test('spec foreach ctrl compose runs end-to-end', async () => {
  const ctx = buildDemoContext();
  const doc = await readSpecYaml('examples/flow/foreach_ctrl_demo/compose.yaml');
  const { results } = await runCompose(ctx, doc.compose, { numbers: [1, 2, 3, 8, 9] });
  assert.deepEqual(results, [1, 3]);
});

test('spec foreach stream compose runs end-to-end', async () => {
  const ctx = buildDemoContext();
  const doc = await readSpecYaml('examples/flow/foreach_stream_demo/compose.yaml');
  const { results } = await runCompose(ctx, doc.compose, { numbers: [1, 2, 3] });
  assert.deepEqual(results, [1, 2, 3]);
});

test('foreach consumes async stream input', async () => {
  const ctx = buildDemoContext();
  async function* makeStream() {
    yield 1;
    yield 2;
    yield 3;
  }
  const compose = [
    {
      call: 'lcod://flow/foreach@1',
      in: { stream: '$.numbers' },
      children: {
        body: [
          { call: 'lcod://impl/echo@1', in: { value: '$slot.item' }, out: { val: 'val' } }
        ]
      },
      collectPath: '$.val',
      out: { results: 'results' }
    }
  ];

  const { results } = await runCompose(ctx, compose, { numbers: makeStream() });
  assert.deepEqual(results, [1, 2, 3]);
});

test('flow throw raises normalized error', async () => {
  const ctx = buildDemoContext();
  await assert.rejects(
    ctx.call('lcod://flow/throw@1', { code: 'boom', message: 'Failure', data: { cause: 'test' } }),
    err => {
      assert.equal(err.code, 'boom');
      assert.equal(err.message, 'Failure');
      assert.deepEqual(err.data, { cause: 'test' });
      return true;
    }
  );
});

test('flow try catches errors and runs finally', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/try@1',
      children: {
        children: [ { call: 'lcod://impl/fail@1' } ],
        catch: [ { call: 'lcod://impl/set@1', in: { message: '$slot.error.message' }, out: { message: 'message' } } ],
        finally: [ { call: 'lcod://impl/cleanup@1', out: { cleaned: 'cleaned' } } ]
      },
      out: { handled: 'message', cleaned: 'cleaned' }
    }
  ];

  const result = await runCompose(ctx, compose, {});
  assert.deepEqual(result, { handled: 'boom', cleaned: true });
});

test('flow try rethrows when catch missing', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/try@1',
      children: {
        children: [ { call: 'lcod://flow/throw@1', in: { message: 'fail', code: 'oops' } } ]
      }
    }
  ];

  await assert.rejects(runCompose(ctx, compose, {}), err => {
    assert.equal(err.code, 'oops');
    assert.equal(err.message, 'fail');
    return true;
  });
});

test('flow parallel collects tasks in input order', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/parallel@1',
      in: { tasks: '$.jobs', parallelism: 2 },
      children: {
        tasks: [
          { call: 'lcod://impl/delay@1', in: { value: '$slot.item.value', ms: '$slot.item.ms' }, out: { value: 'value' } }
        ]
      },
      collectPath: '$.value',
      out: { results: 'results' }
    }
  ];

  const jobs = [
    { value: 'first', ms: 30 },
    { value: 'second', ms: 0 },
    { value: 'third', ms: 10 }
  ];

  const { results } = await runCompose(ctx, compose, { jobs });
  assert.deepEqual(results, ['first', 'second', 'third']);
});
