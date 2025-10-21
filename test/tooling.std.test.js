import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry, Context } from '../src/registry.js';
import { registerTooling } from '../src/tooling/index.js';

function createRegistry() {
  const registry = new Registry();
  registerTooling(registry);
  return registry;
}

test('object.clone deep clones plain objects', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const value = { foo: { bar: 1 }, list: [1, 2] };
  const result = await ctx.call('lcod://tooling/object/clone@0.1.0', { value });

  assert.deepEqual(result.clone, value);
  assert.notStrictEqual(result.clone, value);
  assert.notStrictEqual(result.clone.foo, value.foo);
});

test('object.clone returns empty object for non-objects', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);
  const result = await ctx.call('lcod://tooling/object/clone@0.1.0', { value: null });
  assert.deepEqual(result.clone, {});
});

test('object.set updates nested path without mutating original target', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const target = { nested: { existing: true } };
  const result = await ctx.call('lcod://tooling/object/set@0.1.0', {
    target,
    path: ['nested', 'value'],
    value: 42
  });

  assert.equal(result.object.nested.value, 42);
  assert.deepEqual(result.previous, target);
  assert.strictEqual(result.previous, target);
  assert.equal(target.nested.value, undefined);
});

test('object.set replaces whole object when path is empty', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const result = await ctx.call('lcod://tooling/object/set@0.1.0', {
    target: { foo: 1 },
    path: [],
    value: { replaced: true }
  });

  assert.deepEqual(result.object, { replaced: true });
  assert.deepEqual(result.previous, { foo: 1 });
});

test('object.has resolves existing keys and rejects invalid paths', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const target = { nested: { value: 7 } };
  const found = await ctx.call('lcod://tooling/object/has@0.1.0', {
    target,
    path: ['nested', 'value']
  });
  assert.equal(found.hasKey, true);
  assert.equal(found.value, 7);

  const missing = await ctx.call('lcod://tooling/object/has@0.1.0', {
    target,
    path: ['nested', 'missing']
  });
  assert.equal(missing.hasKey, false);
  assert.equal(missing.value, undefined);
});

test('json.stable_stringify sorts keys deterministically', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const input = { b: { d: 2, c: 1 }, a: 1 };
  const result = await ctx.call('lcod://tooling/json/stable_stringify@0.1.0', {
    value: input
  });

  assert.equal(result.text, '{"a":1,"b":{"c":1,"d":2}}');
  assert.equal(result.warning, null);
});

test('json.stable_stringify returns warning on cyclic structures', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const cyclic = {};
  cyclic.self = cyclic;

  const result = await ctx.call('lcod://tooling/json/stable_stringify@0.1.0', {
    value: cyclic
  });

  assert.equal(result.text, null);
  assert.match(result.warning, /cyclic/i);
});

test('hash.to_key produces base64 digest with optional prefix', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const withPrefix = await ctx.call('lcod://tooling/hash/to_key@0.1.0', {
    text: 'hello',
    prefix: 'id:'
  });
  assert.ok(withPrefix.key.startsWith('id:'));

  const withoutPrefix = await ctx.call('lcod://tooling/hash/to_key@0.1.0', {
    text: 'hello'
  });
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(withoutPrefix.key));
});

test('queue.bfs traverses graph once per key', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  const graph = {
    a: ['b', 'c'],
    b: ['c'],
    c: []
  };

  ctx.runSlot = async (slotName, localState) => {
    if (slotName === 'key') {
      return localState.item.id;
    }
    if (slotName === 'process') {
      const order = Array.isArray(localState.state.order) ? localState.state.order : [];
      const nextOrder = [...order, localState.item.id];
      const children = (graph[localState.item.id] || []).map((id) => ({ id }));
      return {
        state: { order: nextOrder },
        children
      };
    }
    throw new Error(`Unexpected slot: ${slotName}`);
  };

  const result = await ctx.call('lcod://tooling/queue/bfs@0.1.0', {
    items: [{ id: 'a' }],
    state: { order: [] }
  });

  assert.deepEqual(result.state.order, ['a', 'b', 'c']);
  assert.deepEqual(Object.keys(result.visited).sort(), ['a', 'b', 'c']);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.iterations, 4);
});

test('queue.bfs honours maxIterations', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);

  ctx.runSlot = async () => ({ state: {} });

  await assert.rejects(
    () => ctx.call('lcod://tooling/queue/bfs@0.1.0', {
      items: [{ id: 1 }, { id: 2 }],
      maxIterations: 1
    }),
    /maxIterations/
  );
});
