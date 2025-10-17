import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Registry, Context } from '../src/registry.js';
import { registerNodeCore } from '../src/core/index.js';

function createContext() {
  const reg = registerNodeCore(new Registry());
  return new Context(reg);
}

test('core/stream/read and close handle', async () => {
  const ctx = createContext();
  const handle = ctx.streams.createFromAsyncGenerator(async function* () {
    yield Buffer.from('hello');
    yield Buffer.from(' world');
  }, { encoding: 'utf-8' });

  const first = await ctx.call('lcod://contract/core/stream/read@1', { stream: handle, decode: 'utf-8', maxBytes: 5 });
  assert.equal(first.done, false);
  assert.equal(first.chunk, 'hello');

  const second = await ctx.call('lcod://contract/core/stream/read@1', { stream: handle, decode: 'utf-8' });
  assert.equal(second.chunk, ' world');

  const final = await ctx.call('lcod://contract/core/stream/read@1', { stream: handle });
  assert.equal(final.done, true);

  const closed = await ctx.call('lcod://contract/core/stream/close@1', { stream: handle });
  assert.equal(closed.released, true);
});

test('core/http/request returns stream handle', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('hello');
    setTimeout(() => {
      res.end(' world');
    }, 10);
  });
  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();

  const ctx = createContext();
  const response = await ctx.call('lcod://contract/core/http/request@1', {
    url: `http://127.0.0.1:${port}`,
    responseMode: 'stream'
  });

  assert.equal(response.status, 200);
  assert.ok(response.stream);

  const first = await ctx.call('lcod://contract/core/stream/read@1', { stream: response.stream, decode: 'utf-8', maxBytes: 5 });
  assert.equal(first.chunk, 'hello');
  const second = await ctx.call('lcod://contract/core/stream/read@1', { stream: response.stream, decode: 'utf-8' });
  assert.equal(second.chunk.trim(), 'world');
  await ctx.call('lcod://contract/core/stream/close@1', { stream: response.stream });

  await new Promise(resolve => server.close(resolve));
});

test('core/http/request returns buffered body by default', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world' }));
  });
  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();

  const ctx = createContext();
  const response = await ctx.call('lcod://contract/core/http/request@1', {
    url: `http://127.0.0.1:${port}`
  });

  assert.equal(response.status, 200);
  assert.equal(response.bodyEncoding, 'utf-8');
  assert.equal(JSON.parse(response.body).hello, 'world');
  assert.equal(response.stream, undefined);

  await new Promise(resolve => server.close(resolve));
});

test('core/fs read/write/list', async () => {
  const ctx = createContext();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-fs-'));
  const filePath = path.join(tmpDir, 'sample.txt');
  await ctx.call('lcod://contract/core/fs/write-file@1', {
    path: filePath,
    data: 'hello',
    encoding: 'utf-8',
    createParents: true
  });
  const read = await ctx.call('lcod://contract/core/fs/read-file@1', { path: filePath, encoding: 'utf-8' });
  assert.equal(read.data, 'hello');

  const list = await ctx.call('lcod://contract/core/fs/list-dir@1', { path: tmpDir });
  assert.ok(Array.isArray(list.entries));
  assert.equal(list.entries.length, 1);
});

test('core/hash/sha256 computes digest', async () => {
  const ctx = createContext();
  const result = await ctx.call('lcod://contract/core/hash/sha256@1', { data: 'abc', encoding: 'utf-8' });
  assert.equal(result.hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(Buffer.from(result.hex, 'hex').toString('base64'), result.base64);
});

test('core/parse json/toml/csv', async () => {
  const ctx = createContext();
  const json = await ctx.call('lcod://contract/core/parse/json@1', { text: '{"foo": 1}' });
  assert.equal(json.value.foo, 1);

  const toml = await ctx.call('lcod://contract/core/parse/toml@1', { text: 'foo = "bar"' });
  assert.equal(toml.value.foo, 'bar');

  const csv = await ctx.call('lcod://contract/core/parse/csv@1', { text: 'a,b\n1,2', header: true });
  assert.deepEqual(csv.rows, [{ a: '1', b: '2' }]);
});

test('core/array length and push', async () => {
  const ctx = createContext();
  const array = [1, 2, 3];
  const lengthResult = await ctx.call('lcod://contract/core/array/length@1', { items: array });
  assert.equal(lengthResult.length, 3);

  const pushImmutable = await ctx.call('lcod://contract/core/array/push@1', {
    items: array,
    value: 4,
    clone: true
  });
  assert.deepEqual(pushImmutable.items, [1, 2, 3, 4]);
  assert.equal(pushImmutable.length, 4);
  assert.deepEqual(array, [1, 2, 3], 'original array remains intact when clone=true');

  const pushMutable = await ctx.call('lcod://contract/core/array/push@1', {
    items: array,
    value: 5,
    clone: false
  });
  assert.deepEqual(pushMutable.items, [1, 2, 3, 5]);
  assert.equal(pushMutable.length, 4);
  assert.deepEqual(array, [1, 2, 3, 5], 'original array mutated when clone=false');
});

test('core/object get and set', async () => {
  const ctx = createContext();
  const base = { nested: { value: 42 }, list: [10, 20] };

  const getExisting = await ctx.call('lcod://contract/core/object/get@1', {
    object: base,
    path: ['nested', 'value']
  });
  assert.equal(getExisting.value, 42);
  assert.equal(getExisting.found, true);

  const getMissing = await ctx.call('lcod://contract/core/object/get@1', {
    object: base,
    path: ['nested', 'missing'],
    default: 'fallback'
  });
  assert.equal(getMissing.value, 'fallback');
  assert.equal(getMissing.found, false);

  const setImmutable = await ctx.call('lcod://contract/core/object/set@1', {
    object: base,
    path: ['nested', 'value'],
    value: 99,
    clone: true
  });
  assert.equal(setImmutable.created, false);
  assert.equal(setImmutable.object.nested.value, 99);
  assert.equal(base.nested.value, 42, 'original object remains intact when clone=true');

  const setCreate = await ctx.call('lcod://contract/core/object/set@1', {
    object: base,
    path: ['extra', 'flag'],
    value: true,
    clone: false,
    createMissing: true
  });
  assert.equal(setCreate.created, true);
  assert.equal(base.extra.flag, true);

  const setArrayIndex = await ctx.call('lcod://contract/core/object/set@1', {
    object: base,
    path: ['list', 1],
    value: 25,
    clone: false
  });
  assert.equal(setArrayIndex.created, false);
  assert.deepEqual(base.list, [10, 25]);
});
