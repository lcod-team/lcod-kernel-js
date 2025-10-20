import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry, Context } from '../src/registry.js';
import { registerTooling } from '../src/tooling/index.js';
import { runCompose } from '../src/compose.js';
import {
  LOG_CONTRACT_ID,
  KERNEL_HELPER_ID,
  LOG_CONTEXT_HELPER_ID,
  setKernelLogLevel
} from '../src/tooling/logging.js';

function setup() {
  const registry = registerTooling(new Registry());
  const ctx = new Context(registry);
  return { registry, ctx };
}

test('log contract falls back to stdout when unbound', async () => {
  const { registry, ctx } = setup();
  const logs = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  try {
    const capture = (stream) => (chunk) => {
      const text = chunk.toString();
      if (text.trim().startsWith('{')) {
        logs.push({ stream, chunk: text });
      }
      return true;
    };
    process.stdout.write = capture('stdout');
    process.stderr.write = capture('stderr');

    const logImpl = registry.get(LOG_CONTRACT_ID);
    await logImpl.fn(ctx, { level: 'info', message: 'hello' });

    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0].chunk);
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, 'hello');
    assert.ok(entry.timestamp);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
});

test('binding reroutes logs and kernel helper adds component tag', async () => {
  const { registry, ctx } = setup();
  const captured = [];

  registry.register('lcod://impl/testing/logger@1', async (_ctx, input) => {
    captured.push(input);
    return {};
  });
  registry.setBindings({
    [LOG_CONTRACT_ID]: 'lcod://impl/testing/logger@1'
  });

  setKernelLogLevel('trace');
  const logImpl = registry.get(LOG_CONTRACT_ID);
  await logImpl.fn(ctx, { level: 'debug', message: 'app msg', tags: { feature: 'x' } });

  const kernelHelper = registry.get(KERNEL_HELPER_ID);
  await kernelHelper.fn(ctx, { level: 'warn', message: 'kernel msg' });
  setKernelLogLevel('fatal');

  assert.equal(captured.length, 2);
  assert.equal(captured[0].message, 'app msg');
  assert.deepEqual(captured[0].tags, { feature: 'x' });
  assert.equal(captured[1].message, 'kernel msg');
  assert.equal(captured[1].tags.component, 'kernel');
});

test('log context helper merges tags and restores them on exit', async () => {
  const { registry, ctx } = setup();
  const captured = [];
  registry.register('lcod://impl/testing/logger@1', async (_ctx, input) => {
    captured.push(input.tags || {});
    return {};
  });
  registry.setBindings({
    [LOG_CONTRACT_ID]: 'lcod://impl/testing/logger@1'
  });

  const compose = [
    {
      call: LOG_CONTEXT_HELPER_ID,
      in: { tags: { requestId: 'abc' } },
      children: [
        { call: LOG_CONTRACT_ID, in: { level: 'info', message: 'first' } },
        {
          call: LOG_CONTEXT_HELPER_ID,
          in: { tags: { userId: 'u1' } },
          children: [
            { call: LOG_CONTRACT_ID, in: { level: 'info', message: 'nested' } }
          ]
        }
      ]
    },
    { call: LOG_CONTRACT_ID, in: { level: 'info', message: 'after' } }
  ];

  await runCompose(ctx, compose, {});

  assert.equal(captured.length, 3);
  assert.deepEqual(captured[0], { requestId: 'abc' });
  assert.deepEqual(captured[1], { requestId: 'abc', userId: 'u1' });
  assert.deepEqual(captured[2], {});
});
