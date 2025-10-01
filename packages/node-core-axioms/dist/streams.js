import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { createReadStream, promises as fs } from 'fs';

function asAsyncIterator(source) {
  if (!source) return null;
  if (source[Symbol.asyncIterator]) return source[Symbol.asyncIterator]();
  if (typeof source.getReader === 'function') {
    return Readable.from(source)[Symbol.asyncIterator]();
  }
  if (source instanceof Readable) {
    return source[Symbol.asyncIterator]();
  }
  throw new Error('Unsupported stream source');
}

function bufferFromChunk(chunk, defaultEncoding = 'binary') {
  if (chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') {
    const enc = defaultEncoding === 'base64' ? 'base64' : (defaultEncoding === 'hex' ? 'hex' : 'utf8');
    return Buffer.from(chunk, enc);
  }
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new Error('Unsupported chunk type');
}

export class StreamManager {
  constructor() {
    this.handles = new Map();
  }

  _register(entry) {
    this.handles.set(entry.handle.id, entry);
    return entry.handle;
  }

  createFromReadable(readable, opts = {}) {
    const iterator = asAsyncIterator(readable);
    if (!iterator) throw new Error('Readable source required');
    const id = randomUUID();
    const handle = {
      id,
      encoding: opts.encoding || 'binary',
      mediaType: opts.mediaType,
      storage: opts.storage || { kind: 'stream' },
      metadata: opts.metadata || {}
    };
    const entry = {
      handle,
      iterator,
      encoding: handle.encoding,
      pending: null,
      done: false,
      seq: 0,
      close: async () => {
        if (readable?.destroy) readable.destroy();
      }
    };
    return this._register(entry);
  }

  createFromAsyncGenerator(generator, opts = {}) {
    const iterator = typeof generator === 'function'
      ? generator()[Symbol.asyncIterator]()
      : generator[Symbol.asyncIterator]();
    const id = randomUUID();
    const handle = {
      id,
      encoding: opts.encoding || 'binary',
      mediaType: opts.mediaType,
      storage: opts.storage || { kind: 'stream' },
      metadata: opts.metadata || {}
    };
    const entry = {
      handle,
      iterator,
      encoding: handle.encoding,
      pending: null,
      done: false,
      seq: 0,
      close: async () => {}
    };
    return this._register(entry);
  }

  createFromFile(path, opts = {}) {
    const id = randomUUID();
    const handle = {
      id,
      encoding: opts.encoding || 'binary',
      mediaType: opts.mediaType,
      storage: { kind: 'file', path },
      metadata: opts.metadata || {}
    };
    const entry = {
      handle,
      path,
      encoding: handle.encoding,
      iterator: null,
      pending: null,
      done: false,
      seq: 0,
      close: async () => {
        if (entry.stream && entry.stream.destroy) entry.stream.destroy();
      }
    };
    return this._register(entry);
  }

  createFromBuffer(buffer, opts = {}) {
    const id = randomUUID();
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    const handle = {
      id,
      encoding: opts.encoding || 'base64',
      mediaType: opts.mediaType,
      storage: { kind: 'memory', size: data.length },
      metadata: opts.metadata || {}
    };
    const entry = {
      handle,
      encoding: handle.encoding,
      buffer: data,
      offset: 0,
      pending: null,
      done: false,
      seq: 0,
      close: async () => {}
    };
    return this._register(entry);
  }

  _getEntry(handle) {
    if (!handle || typeof handle.id !== 'string') throw new Error('Invalid stream handle');
    const entry = this.handles.get(handle.id);
    if (!entry) throw new Error(`Unknown stream handle: ${handle.id}`);
    return entry;
  }

  async read(handle, options = {}) {
    const entry = this._getEntry(handle);
    if (entry.done && (!entry.pending || entry.pending.length === 0)) {
      return { done: true, stream: entry.handle };
    }

    const maxBytes = options.maxBytes;
    const decode = options.decode || entry.encoding || 'binary';

    let buffer = entry.pending || Buffer.alloc(0);
    entry.pending = null;

    const pullNextChunk = async (ent) => {
      if (ent.buffer) {
        if (ent.offset >= ent.buffer.length) {
          ent.done = true;
          return null;
        }
        const cap = maxBytes ? ent.offset + maxBytes : ent.buffer.length;
        const chunk = ent.buffer.slice(ent.offset, cap);
        ent.offset += chunk.length;
        if (ent.offset >= ent.buffer.length) ent.done = true;
        return chunk;
      }

      if (ent.path) {
        if (!ent.iterator) {
          ent.stream = createReadStream(ent.path);
          ent.iterator = ent.stream[Symbol.asyncIterator]();
        }
      }

      if (ent.iterator) {
        const { value, done } = await ent.iterator.next();
        if (done || value == null) {
          ent.done = true;
          return null;
        }
        return bufferFromChunk(value, ent.encoding);
      }

      return null;
    };

    while ((!maxBytes || buffer.length < maxBytes) && !entry.done) {
      const chunk = await pullNextChunk(entry);
      if (!chunk || chunk.length === 0) break;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (maxBytes && buffer.length >= maxBytes) break;
    }

    if (!buffer.length && entry.done) {
      return { done: true, stream: entry.handle };
    }

    let carry = null;
    if (maxBytes && buffer.length > maxBytes) {
      carry = buffer.slice(maxBytes);
      buffer = buffer.slice(0, maxBytes);
    }
    entry.pending = carry;

    let chunkOut;
    let encodingOut = decode;
    if (decode === 'utf-8' || decode === 'utf8') {
      chunkOut = buffer.toString('utf8');
      encodingOut = 'utf-8';
    } else if (decode === 'json') {
      chunkOut = buffer.toString('utf8');
      encodingOut = 'json';
    } else if (decode === 'base64') {
      chunkOut = buffer.toString('base64');
      encodingOut = 'base64';
    } else if (decode === 'hex') {
      chunkOut = buffer.toString('hex');
      encodingOut = 'hex';
    } else {
      chunkOut = buffer.toString('base64');
      encodingOut = 'base64';
    }

    const seq = entry.seq++;
    return {
      done: false,
      chunk: chunkOut,
      encoding: encodingOut,
      bytes: buffer.length,
      seq,
      stream: entry.handle
    };
  }

  async close(handle, options = {}) {
    const entry = this._getEntry(handle);
    if (entry.close) await entry.close();
    let removed = false;
    if (options.deleteFile && entry.handle.storage?.kind === 'file' && entry.handle.storage.path) {
      try {
        await fs.unlink(entry.handle.storage.path);
        removed = true;
      } catch (_err) {
        removed = false;
      }
    }
    this.handles.delete(entry.handle.id);
    return { released: true, removed };
  }
}

export function registerStreamContracts(reg) {
  reg.register('lcod://contract/core/stream/read@1', async (ctx, input = {}) => {
    if (!ctx.streams) throw new Error('Stream manager not initialised');
    const { stream, maxBytes, timeoutMs, decode } = input;
    if (!stream) throw new Error('stream handle required');
    const opts = {};
    if (maxBytes != null) opts.maxBytes = maxBytes;
    if (timeoutMs != null) opts.timeoutMs = timeoutMs;
    if (decode) opts.decode = decode;
    return ctx.streams.read(stream, opts);
  });

  reg.register('lcod://contract/core/stream/close@1', async (ctx, input = {}) => {
    if (!ctx.streams) throw new Error('Stream manager not initialised');
    const { stream, deleteFile } = input;
    if (!stream) throw new Error('stream handle required');
    return ctx.streams.close(stream, { deleteFile });
  });

  return reg;
}
