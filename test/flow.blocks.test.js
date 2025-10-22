import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { Registry, Context, createCancellationToken, ExecutionCancelledError } from '../src/registry.js';
import { registerDemoAxioms } from '../src/axioms.js';
import { runCompose } from '../src/compose.js';
import { flowIf } from '../src/flow/if.js';
import { flowForeach } from '../src/flow/foreach.js';
import { flowParallel } from '../src/flow/parallel.js';
import { flowTry } from '../src/flow/try.js';
import { flowThrow } from '../src/flow/throw.js';
import { flowBreak } from '../src/flow/break.js';
import { flowContinue } from '../src/flow/continue.js';
import { flowCheckAbort } from '../src/flow/check_abort.js';
import { flowWhile } from '../src/flow/while.js';
import { registerStreamContracts } from '../src/core/streams.js';

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

function createChunkStream(ctx) {
  return ctx.streams.createFromAsyncGenerator(async function* () {
    yield Buffer.from('123456', 'utf8');
  }, { encoding: 'utf-8' });
}

function attemptsBudget(count = 8) {
  return Array.from({ length: count }, (_, i) => i);
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
  reg.register('lcod://flow/check_abort@1', flowCheckAbort);
  reg.register('lcod://flow/while@1', flowWhile);
  reg.register('lcod://test/inc@1', async (_ctx, { count = 0 }) => ({ count: count + 1 }));
  reg.register('lcod://test/lt@1', async (_ctx, { value = 0, limit = 0 }) => ({ ok: value < limit }));
  reg.register('lcod://test/cancel_when@1', async (ctx, { count = 0, cancelAt = 0 }) => {
    const next = count + 1;
    if (next >= cancelAt) {
      ctx.cancel();
    }
    return { count: next };
  });
  registerStreamContracts(reg);
  return new Context(reg);
}

test('foreach collects child output with collectPath', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/foreach@1',
      in: { list: '$.numbers' },
      slots: {
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
      slots: {
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
      slots: { body: [] },
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
      slots: {
        body: [
          { call: 'lcod://impl/is_even@1', in: { value: '$slot.item' }, out: { isEven: 'ok' } },
          { call: 'lcod://flow/if@1', in: { cond: '$.isEven' }, slots: { then: [ { call: 'lcod://flow/continue@1' } ] } },
          { call: 'lcod://impl/gt@1', in: { value: '$slot.item', limit: 7 }, out: { tooBig: 'ok' } },
          { call: 'lcod://flow/if@1', in: { cond: '$.tooBig' }, slots: { then: [ { call: 'lcod://flow/break@1' } ] } },
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
  const handle = createChunkStream(ctx);
  const { results } = await runCompose(ctx, doc.compose, {
    numbers: { stream: handle },
    attempts: attemptsBudget(10)
  });
  assert.deepEqual(results, ['12', '34', '56']);
  await assert.rejects(
    ctx.call('lcod://contract/core/stream/read@1', { stream: handle }),
    /Unknown stream handle/
  );
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
      slots: {
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
      slots: {
        body: [ { call: 'lcod://impl/fail@1' } ],
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
      slots: {
        body: [ { call: 'lcod://flow/throw@1', in: { message: 'fail', code: 'oops' } } ]
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
      slots: {
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

test('flow while iterates until condition fails', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/while@1',
      in: { state: { count: 0 }, maxIterations: 10 },
      slots: {
        condition: [
          { call: 'lcod://test/lt@1', in: { value: '$.count', limit: 3 }, out: { shouldContinue: 'ok' } },
          { call: 'lcod://impl/set@1', in: { continue: '$.shouldContinue' }, out: { continue: 'continue' } }
        ],
        body: [
          { call: 'lcod://test/inc@1', in: { count: '$.count' }, out: { count: 'count' } }
        ]
      },
      out: { state: 'state', iterations: 'iterations' }
    }
  ];

  const result = await runCompose(ctx, compose, {});
  assert.deepEqual(result, { state: { count: 3 }, iterations: 3 });
});

test('flow while enforces maxIterations', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/while@1',
      in: { state: { count: 0 }, maxIterations: 2 },
      slots: {
        condition: [
          { call: 'lcod://impl/set@1', in: { continue: true }, out: { continue: 'continue' } }
        ],
        body: [
          { call: 'lcod://test/inc@1', in: { count: '$.count' }, out: { count: 'count' } }
        ]
      }
    }
  ];

  await assert.rejects(
    runCompose(ctx, compose, {}),
    err => {
      assert.match(err?.message ?? '', /maxIterations/);
      return true;
    }
  );
});

test('flow while runs else branch when loop never executes', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/while@1',
      in: { state: { count: 0 } },
      slots: {
        condition: [
          { call: 'lcod://impl/set@1', in: { continue: false }, out: { continue: 'continue' } }
        ],
        else: [
          { call: 'lcod://impl/set@1', in: { count: 42 }, out: { count: 'count' } }
        ]
      },
      out: { state: 'state', iterations: 'iterations' }
    }
  ];

  const result = await runCompose(ctx, compose, {});
  assert.deepEqual(result, { state: { count: 42 }, iterations: 0 });
});

test('flow check_abort stops execution when cancelled', async () => {
  const reg = new Registry();
  reg.register('lcod://flow/check_abort@1', flowCheckAbort);
  reg.register('lcod://impl/echo@1', async (_ctx, { value }) => ({ val: value }));
  const token = createCancellationToken();
  token.cancel();
  const ctx = new Context(reg, { cancellation: token });
  const compose = [
    { call: 'lcod://flow/check_abort@1' },
    { call: 'lcod://impl/echo@1', in: { value: 'should not run' }, out: { val: 'val' } }
  ];
  await assert.rejects(runCompose(ctx, compose, {}), ExecutionCancelledError);
});

test('flow while respects cancellation signalled within body', async () => {
  const ctx = buildDemoContext();
  const compose = [
    {
      call: 'lcod://flow/while@1',
      in: { state: { count: 0 }, maxIterations: 10 },
      slots: {
        condition: [
          { call: 'lcod://impl/set@1', in: { continue: true }, out: { continue: 'continue' } }
        ],
        body: [
          { call: 'lcod://test/cancel_when@1', in: { count: '$.count', cancelAt: 3 }, out: { count: 'count' } }
        ]
      }
    }
  ];

  await assert.rejects(runCompose(ctx, compose, {}), ExecutionCancelledError);
});
