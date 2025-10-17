import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { parse as parseCsv } from 'csv-parse/sync';
import { registerStreamContracts, StreamManager } from './streams.js';

const execFileAsync = promisify(execFile);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneContainer(value) {
  if (Array.isArray(value)) return value.slice();
  if (isPlainObject(value)) return { ...value };
  return value;
}

function normalizePathSegment(segment) {
  if (typeof segment === 'number' && Number.isInteger(segment)) return segment;
  if (typeof segment === 'string' && segment.length > 0) return segment;
  throw new Error(`invalid path segment: ${String(segment)}`);
}

function coerceArrayIndex(segment) {
  if (typeof segment === 'number' && Number.isInteger(segment)) return segment;
  const parsed = Number.parseInt(String(segment), 10);
  if (Number.isNaN(parsed)) throw new Error(`invalid array index: ${String(segment)}`);
  return parsed;
}

function resolveObjectPath(source, segments) {
  if (!Array.isArray(segments)) throw new Error('path must be an array');
  if (segments.length === 0) return { value: source, found: true };
  let current = source;
  for (const rawSegment of segments) {
    const segment = normalizePathSegment(rawSegment);
    if (Array.isArray(current)) {
      const index = coerceArrayIndex(segment);
      if (index < 0 || index >= current.length) return { value: undefined, found: false };
      current = current[index];
    } else if (isPlainObject(current)) {
      const key = typeof segment === 'string' ? segment : String(segment);
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        return { value: undefined, found: false };
      }
      current = current[key];
    } else {
      return { value: undefined, found: false };
    }
  }
  return { value: current, found: true };
}

function resolveCacheCandidates(projectPath) {
  const candidates = [];
  if (projectPath) candidates.push(path.join(projectPath, '.lcod', 'cache'));
  if (process.env.LCOD_CACHE_DIR) candidates.push(path.resolve(process.env.LCOD_CACHE_DIR));
  try {
    const homeCache = path.join(os.homedir(), '.cache', 'lcod');
    candidates.push(homeCache);
  } catch {
    // homedir not available (non-POSIX env)
  }
  return candidates.filter(Boolean);
}

async function ensureCacheDir(projectPath) {
  const candidates = resolveCacheCandidates(projectPath);
  for (const candidate of candidates) {
    try {
      await fs.mkdir(candidate, { recursive: true });
      return candidate;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return candidate;
      }
    }
  }
  const fallback = path.join(projectPath || process.cwd(), '.lcod', 'cache');
  await fs.mkdir(fallback, { recursive: true });
  return fallback;
}

function computeCacheKey(parts) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(parts));
  return hash.digest('hex');
}

function integrityFromBuffer(buffer) {
  return `sha256-${crypto.createHash('sha256').update(buffer).digest('base64')}`;
}

function ensureStreamManager(ctx) {
  if (!ctx.streams) ctx.streams = new StreamManager();
  return ctx.streams;
}

async function readAllFromStream(ctx, handle, decode = 'utf-8') {
  const manager = ensureStreamManager(ctx);
  let done = false;
  let data = '';
  while (!done) {
    const res = await manager.read(handle, { decode });
    if (res.done) break;
    data += res.chunk ?? '';
  }
  await manager.close(handle, {});
  return data;
}

async function readInputAsBuffer(ctx, input) {
  if (input.data != null) {
    const encoding = input.encoding || 'utf-8';
    if (encoding === 'base64') return Buffer.from(input.data, 'base64');
    if (encoding === 'hex') return Buffer.from(input.data, 'hex');
    return Buffer.from(input.data, 'utf8');
  }
  if (input.path) {
    return fs.readFile(input.path);
  }
  if (input.stream) {
    const manager = ensureStreamManager(ctx);
    const chunks = [];
    while (true) {
      const res = await manager.read(input.stream, { decode: 'base64', maxBytes: input.chunkSize });
      if (res.done) break;
      chunks.push(Buffer.from(res.chunk, 'base64'));
    }
    await manager.close(input.stream, {});
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

async function resolveTextInput(ctx, input, defaultEncoding = 'utf-8') {
  if (input.text != null) return input.text;
  if (input.path) {
    return fs.readFile(input.path, input.encoding || defaultEncoding);
  }
  if (input.stream) {
    return readAllFromStream(ctx, input.stream, input.encoding || defaultEncoding);
  }
  throw new Error('No input provided');
}

export function registerNodeCore(reg) {
  registerStreamContracts(reg);

  // Filesystem contracts
  reg.register('lcod://contract/core/fs/read-file@1', async (_ctx, input = {}) => {
    const { path: filePath, encoding = 'utf-8' } = input;
    if (!filePath) throw new Error('path is required');
    const stats = await fs.stat(filePath);
    let data;
    let actualEncoding = encoding;
    if (encoding === 'base64' || encoding === 'hex') {
      const buf = await fs.readFile(filePath);
      data = buf.toString(encoding);
    } else {
      data = await fs.readFile(filePath, { encoding });
    }
    return {
      data,
      encoding: actualEncoding,
      size: stats.size,
      mtime: stats.mtime.toISOString()
    };
  });

  reg.register('lcod://contract/core/fs/write-file@1', async (_ctx, input = {}) => {
    const { path: filePath, data, encoding = 'utf-8', append = false, createParents = false, mode } = input;
    if (!filePath) throw new Error('path is required');
    const dir = path.dirname(filePath);
    if (createParents) await fs.mkdir(dir, { recursive: true });
    let buf;
    if (encoding === 'base64' || encoding === 'hex') {
      buf = Buffer.from(data ?? '', encoding);
    } else {
      buf = Buffer.from(data ?? '', 'utf8');
    }
    const flag = append ? 'a' : 'w';
    await fs.writeFile(filePath, buf, { flag, mode });
    const stats = await fs.stat(filePath);
    return {
      bytesWritten: buf.length,
      mtime: stats.mtime.toISOString()
    };
  });

  reg.register('lcod://contract/core/fs/list-dir@1', async (_ctx, input = {}) => {
    const { path: dirPath, recursive = false, maxDepth = Infinity, includeStats = false, includeHidden = false, pattern } = input;
    if (!dirPath) throw new Error('path is required');
    const entries = [];
    const walk = async (current, depth) => {
      const dirEntries = await fs.readdir(current, { withFileTypes: true });
      for (const ent of dirEntries) {
        if (!includeHidden && ent.name.startsWith('.')) continue;
        const fullPath = path.join(current, ent.name);
        if (pattern && !fullPath.includes(pattern.replace('**/', ''))) {
          // simple naive filter
        }
        const item = {
          name: ent.name,
          path: fullPath,
          type: ent.isDirectory() ? 'directory' : (ent.isSymbolicLink() ? 'symlink' : 'file')
        };
        if (includeStats) {
          const stats = await fs.stat(fullPath);
          item.size = stats.size;
          item.mtime = stats.mtime.toISOString();
        }
        entries.push(item);
        if (recursive && ent.isDirectory() && depth < maxDepth) {
          await walk(fullPath, depth + 1);
        }
      }
    };
    await walk(dirPath, 0);
    return { entries };
  });

  // Stream contracts already registered above.

  // HTTP contract
  reg.register('lcod://contract/core/http/request@1', async (ctx, input = {}) => {
    const { method = 'GET', url, headers = {}, query, body, bodyEncoding = 'none', timeoutMs, followRedirects = true, responseMode = 'buffer' } = input;
    if (!url) throw new Error('url is required');
    const target = new URL(url);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (Array.isArray(v)) {
          v.forEach(val => target.searchParams.append(k, String(val)));
        } else if (v != null) {
          target.searchParams.append(k, String(v));
        }
      }
    }

    const controller = new AbortController();
    let timeout;
    if (timeoutMs) {
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const init = {
        method,
        headers: {} ,
        redirect: followRedirects ? 'follow' : 'manual',
        signal: controller.signal
      };
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) init.headers[key] = value.join(', ');
        else init.headers[key] = String(value);
      }
      if (body != null) {
        if (bodyEncoding === 'json') {
          init.body = JSON.stringify(body);
          init.headers['content-type'] = init.headers['content-type'] || 'application/json';
        } else if (bodyEncoding === 'base64') {
          init.body = Buffer.from(body, 'base64');
        } else if (bodyEncoding === 'form' && typeof body === 'object') {
          const params = new URLSearchParams();
          Object.entries(body).forEach(([k, v]) => params.append(k, String(v)));
          init.body = params.toString();
          init.headers['content-type'] = init.headers['content-type'] || 'application/x-www-form-urlencoded';
        } else {
          init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
      }

      const res = await fetch(target, init);
      const headerObj = {};
      res.headers.forEach((value, key) => {
        if (!headerObj[key]) headerObj[key] = [];
        headerObj[key].push(value);
      });

      const base = {
        status: res.status,
        statusText: res.statusText,
        headers: headerObj
      };

      const contentType = res.headers.get('content-type') || undefined;

      if (responseMode === 'stream') {
        const readable = res.body ? Readable.from(res.body) : Readable.from([]);
        const handle = ensureStreamManager(ctx).createFromReadable(readable, { encoding: 'binary', mediaType: contentType });
        return { ...base, stream: handle };
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      let bodyEncodingOut = 'utf-8';
      let bodyOut;
      if (contentType && /application\/json|text\//.test(contentType)) {
        bodyOut = buffer.toString('utf8');
      } else {
        bodyOut = buffer.toString('base64');
        bodyEncodingOut = 'base64';
      }
      return { ...base, body: bodyOut, bodyEncoding: bodyEncodingOut };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });

  // Git clone contract
  reg.register('lcod://contract/core/git/clone@1', async (_ctx, input = {}) => {
    const { url, ref, depth, subdir, dest, auth } = input;
    if (!url) throw new Error('url is required');
    const targetDir = dest ? path.resolve(dest) : path.resolve('.lcod-cache', crypto.randomUUID());
    await fs.mkdir(targetDir, { recursive: true });
    const args = ['clone', url, targetDir];
    if (depth) args.splice(1, 0, `--depth=${depth}`);
    if (ref) args.push('--branch', ref);
    const env = { ...process.env };
    if (auth?.token) env.GIT_ASKPASS = 'echo';
    await execFileAsync('git', args, { env });
    let commit = ref;
    if (!commit || commit.startsWith('refs/')) {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: targetDir });
      commit = stdout.trim();
    }
    let exposedPath = targetDir;
    if (subdir) exposedPath = path.join(targetDir, subdir);
    return {
      path: exposedPath,
      commit,
      ref: ref || null,
      subdir: subdir || null,
      source: {
        url,
        fetchedAt: new Date().toISOString()
      }
    };
  });

  // Hash contract
  reg.register('lcod://contract/core/hash/sha256@1', async (ctx, input = {}) => {
    const buffer = await readInputAsBuffer(ctx, input);
    const bytes = buffer.length;
    const hash = crypto.createHash('sha256');
    hash.update(buffer);
    const hex = hash.digest('hex');
    const base64 = Buffer.from(hex, 'hex').toString('base64');
    return { hex, base64, bytes };
  });

  // JSON parse
  reg.register('lcod://contract/core/parse/json@1', async (ctx, input = {}) => {
    const text = await resolveTextInput(ctx, input, input.encoding || 'utf-8');
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON parse error: ${err.message}`);
    }
    return { value, bytes: Buffer.byteLength(text, input.encoding || 'utf-8'), validated: false };
  });

  // TOML parse
  reg.register('lcod://contract/core/parse/toml@1', async (ctx, input = {}) => {
    const text = await resolveTextInput(ctx, input, input.encoding || 'utf-8');
    let value;
    try {
      value = parseToml(text);
    } catch (err) {
      throw new Error(`TOML parse error: ${err.message}`);
    }
    return { value, bytes: Buffer.byteLength(text, input.encoding || 'utf-8') };
  });

  // CSV parse
  reg.register('lcod://contract/core/parse/csv@1', async (ctx, input = {}) => {
    const text = await resolveTextInput(ctx, input, input.encoding || 'utf-8');
    const delimiter = input.delimiter || ',';
    const quote = input.quote || '"';
    const trim = Boolean(input.trim);
    const header = input.header;
    const columns = Array.isArray(header) ? header : undefined;
    const records = parseCsv(text, {
      columns: columns || (header === true),
      delimiter,
      quote,
      trim
    });

    let rows;
    if (Array.isArray(records)) {
      rows = records;
    } else {
      rows = Object.values(records);
    }

    return {
      rows,
      columns: Array.isArray(columns) ? columns : undefined,
      bytes: Buffer.byteLength(text, input.encoding || 'utf-8')
    };
  });

  reg.register('lcod://contract/core/array/length@1', async (_ctx, input = {}) => {
    const { items } = input;
    if (!Array.isArray(items)) throw new Error('items must be an array');
    return { length: items.length };
  });

  reg.register('lcod://contract/core/array/push@1', async (_ctx, input = {}) => {
    const { items, value, clone = true } = input;
    if (!Array.isArray(items)) throw new Error('items must be an array');
    const target = clone ? items.slice() : items;
    target.push(value);
    return { items: target, length: target.length };
  });

  reg.register('lcod://contract/core/object/get@1', async (_ctx, input = {}) => {
    const { object, path: segments, default: defaultValue } = input;
    if (!isPlainObject(object) && !Array.isArray(object)) {
      throw new Error('object must be an object');
    }
    if (!Array.isArray(segments)) throw new Error('path must be an array');
    const { value, found } = resolveObjectPath(object, segments);
    return { value: found ? value : defaultValue, found };
  });

  reg.register('lcod://contract/core/object/set@1', async (_ctx, input = {}) => {
    const { object, path: segments, value, clone = true, createMissing = true } = input;
    if (!isPlainObject(object) && !Array.isArray(object)) {
      throw new Error('object must be an object');
    }
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('path must be a non-empty array');
    }
    const { found } = resolveObjectPath(object, segments);
    const targetRoot = clone ? cloneContainer(object) : object;
    let cursor = targetRoot;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = normalizePathSegment(segments[i]);
      const last = i === segments.length - 1;
      if (last) {
        if (Array.isArray(cursor)) {
          const index = coerceArrayIndex(segment);
          cursor[index] = value;
        } else if (isPlainObject(cursor)) {
          const key = typeof segment === 'string' ? segment : String(segment);
          cursor[key] = value;
        } else {
          throw new Error(`cannot set value at segment ${String(segment)}`);
        }
      } else {
        const nextSegment = normalizePathSegment(segments[i + 1]);
        if (Array.isArray(cursor)) {
          const index = coerceArrayIndex(segment);
          let next = cursor[index];
          if (next == null) {
            if (!createMissing) {
              throw new Error(`missing segment ${String(segment)}`);
            }
            next = typeof nextSegment === 'number' ? [] : {};
          } else if (clone) {
            next = cloneContainer(next);
          }
          cursor[index] = next;
          cursor = next;
        } else if (isPlainObject(cursor)) {
          const key = typeof segment === 'string' ? segment : String(segment);
          let next = cursor[key];
          if (next == null) {
            if (!createMissing) {
              throw new Error(`missing segment ${String(segment)}`);
            }
            next = typeof nextSegment === 'number' ? [] : {};
          } else if (clone) {
            next = cloneContainer(next);
          }
          cursor[key] = next;
          cursor = next;
        } else {
          throw new Error(`cannot traverse segment ${String(segment)}`);
        }
      }
    }

    return { object: targetRoot, created: !found };
  });

  return reg;
}


export function registerNodeResolverAxioms(reg) {
  const aliasContract = (contractId, axiomId) => {
    const entry = reg.get(contractId);
    if (!entry) throw new Error(`Contract not registered: ${contractId}`);
    reg.register(axiomId, entry.fn, {
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      implements: entry.implements
    });
  };

  reg.register('lcod://tooling/resolver/cache-dir@1', async (_ctx, input = {}) => {
    const projectPathInput = typeof input.projectPath === 'string' && input.projectPath
      ? input.projectPath
      : process.cwd();
    const cachePath = await ensureCacheDir(path.resolve(projectPathInput));
    return { path: cachePath };
  });

  reg.register('lcod://axiom/path/join@1', async (_ctx, input = {}) => {
    const base = input.base ?? '';
    const segment = input.segment ?? '';
    return { path: path.join(base, segment) };
  });

  reg.register('lcod://axiom/json/parse@1', async (_ctx, input = {}) => {
    const text = input.text;
    if (typeof text !== 'string') throw new Error('text is required');
    return { value: JSON.parse(text) };
  });

  reg.register('lcod://axiom/toml/parse@1', async (_ctx, input = {}) => {
    const text = input.text;
    if (typeof text !== 'string') throw new Error('text is required');
    return { value: parseToml(text) };
  });

  reg.register('lcod://axiom/toml/stringify@1', async (_ctx, input = {}) => {
    const value = input.value ?? {};
    const text = stringifyToml(value);
    return { text };
  });

  reg.register('lcod://axiom/http/download@1', async (_ctx, input = {}) => {
    const url = input.url;
    const filePath = input.path;
    if (!url || !filePath) throw new Error('url and path are required');
    const init = { method: input.method || 'GET', headers: input.headers || {} };
    if (input.query) {
      const target = new URL(url);
      for (const [k, v] of Object.entries(input.query)) {
        if (Array.isArray(v)) {
          v.forEach(val => target.searchParams.append(k, String(val)));
        } else if (v != null) {
          target.searchParams.append(k, String(v));
        }
      }
      init.url = target.toString();
    }
    const response = await fetch(init.url || url, init);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} when downloading ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    const headers = Object.fromEntries(response.headers.entries());
    return { status: response.status, headers, bytes: buffer.length };
  });

  aliasContract('lcod://contract/core/fs/read-file@1', 'lcod://axiom/fs/read-file@1');
  aliasContract('lcod://contract/core/fs/write-file@1', 'lcod://axiom/fs/write-file@1');
  aliasContract('lcod://contract/core/hash/sha256@1', 'lcod://axiom/hash/sha256@1');
  aliasContract('lcod://contract/core/git/clone@1', 'lcod://axiom/git/clone@1');
  aliasContract('lcod://contract/core/array/length@1', 'lcod://axiom/array/length@1');
  aliasContract('lcod://contract/core/array/push@1', 'lcod://axiom/array/push@1');
  aliasContract('lcod://contract/core/object/get@1', 'lcod://axiom/object/get@1');
  aliasContract('lcod://contract/core/object/set@1', 'lcod://axiom/object/set@1');

  reg.register('lcod://contract/tooling/resolve-dependency@1', async (_ctx, input = {}) => {
    const dependency = typeof input.dependency === 'string' && input.dependency
      ? input.dependency
      : 'unknown';
    return {
      resolved: {
        id: dependency,
        source: { type: 'registry', reference: dependency },
        dependencies: []
      },
      warnings: [
        'contract/tooling/resolve-dependency@1 is deprecated; use the resolver compose pipeline instead.'
      ]
    };
  });

  reg.register('lcod://impl/set@1', async (_ctx, input = {}) => ({ ...input }));

  return reg;
}
