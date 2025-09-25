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
