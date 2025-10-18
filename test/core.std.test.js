import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry, Context } from '../src/registry.js';
import { registerNodeCore } from '../src/core/index.js';

function createContext() {
  const reg = registerNodeCore(new Registry());
  return new Context(reg);
}

test('core/object/merge shallow and deep merge behaviour', async () => {
  const ctx = createContext();
  const left = { a: 1, nested: { flag: true }, arr: [1, 2] };
  const right = { b: 2, nested: { flag: false, extra: 'x' }, arr: [3], label: 'y' };

  const shallow = await ctx.call('lcod://contract/core/object/merge@1', { left, right });
  assert.deepEqual(shallow.value, {
    a: 1,
    nested: { flag: false, extra: 'x' },
    arr: [3],
    b: 2,
    label: 'y'
  });
  assert.deepEqual(shallow.conflicts, ['arr', 'b', 'label', 'nested']);
  assert.deepEqual(left, { a: 1, nested: { flag: true }, arr: [1, 2] }, 'left remains immutable');

  const deep = await ctx.call('lcod://contract/core/object/merge@1', {
    left,
    right,
    deep: true,
    arrayStrategy: 'concat'
  });
  assert.deepEqual(deep.value, {
    a: 1,
    nested: { flag: false, extra: 'x' },
    arr: [1, 2, 3],
    b: 2,
    label: 'y'
  });
});

test('core/array/append concatenates values immutably', async () => {
  const ctx = createContext();
  const base = ['alpha', 'beta'];
  const result = await ctx.call('lcod://contract/core/array/append@1', {
    array: base,
    items: ['gamma'],
    item: 'delta'
  });
  assert.deepEqual(result.value, ['alpha', 'beta', 'gamma', 'delta']);
  assert.equal(result.length, 4);
  assert.deepEqual(base, ['alpha', 'beta'], 'base array unchanged');
});

test('core/string/format resolves placeholders and reports missing keys', async () => {
  const ctx = createContext();
  const formatted = await ctx.call('lcod://contract/core/string/format@1', {
    template: 'Hello {user.name}, you have {stats.count} messages',
    values: { user: { name: 'Ada' }, stats: { count: 3 } }
  });
  assert.equal(formatted.value, 'Hello Ada, you have 3 messages');
  assert.deepEqual(formatted.missing ?? [], []);

  const missing = await ctx.call('lcod://contract/core/string/format@1', {
    template: 'Hello {user.name}, missing {stats.missing}',
    values: { user: { name: 'Ada' }, stats: {} },
    fallback: '??'
  });
  assert.equal(missing.value, 'Hello Ada, missing ??');
  assert.deepEqual(missing.missing, ['stats.missing']);

  const missingError = await ctx.call('lcod://contract/core/string/format@1', {
    template: '{unknown}',
    values: {},
    missingPolicy: 'error'
  });
  assert.deepEqual(missingError.error?.code, 'MISSING_PLACEHOLDER');
});

test('core/json encode/decode handles options', async () => {
  const ctx = createContext();
  const encode = await ctx.call('lcod://contract/core/json/encode@1', {
    value: { b: 1, a: 'é' },
    sortKeys: true,
    asciiOnly: true
  });
  assert.ok(encode.text.startsWith('{'), 'returns JSON text');
  assert.match(encode.text, /"a":"\\u00e9"/);
  assert.equal(encode.bytes, Buffer.byteLength(encode.text, 'utf8'));

  const decode = await ctx.call('lcod://contract/core/json/decode@1', {
    text: encode.text
  });
  assert.deepEqual(decode.value, { a: 'é', b: 1 });
  assert.equal(decode.bytes, encode.bytes);
});
