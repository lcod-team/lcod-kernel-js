import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify, isDeepStrictEqual } from 'util';
import crypto from 'crypto';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { parse as parseCsv } from 'csv-parse/sync';
import { registerStreamContracts, StreamManager } from './streams.js';
import { registerState } from './state.js';

const execFileAsync = promisify(execFile);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneContainer(value) {
  if (Array.isArray(value)) return value.slice();
  if (isPlainObject(value)) return { ...value };
  return value;
}

function normalizeArrayStrategy(strategy) {
  return strategy === 'concat' ? 'concat' : 'replace';
}

function mergePlainObjects(left = {}, right = {}, options = {}) {
  const deep = options.deep === true;
  const arrayStrategy = normalizeArrayStrategy(options.arrayStrategy);
  const base = isPlainObject(left) ? left : {};
  const overlay = isPlainObject(right) ? right : {};
  const result = { ...base };
  const conflicts = new Set();

  for (const key of Object.keys(overlay)) {
    conflicts.add(key);
    const rightValue = overlay[key];
    const leftValue = base[key];
    if (deep && isPlainObject(leftValue) && isPlainObject(rightValue)) {
      result[key] = mergePlainObjects(leftValue, rightValue, { deep, arrayStrategy }).value;
      continue;
    }
    if (deep && Array.isArray(leftValue) && Array.isArray(rightValue)) {
      if (arrayStrategy === 'concat') {
        result[key] = leftValue.concat(rightValue);
      } else {
        result[key] = rightValue.slice();
      }
      continue;
    }
    result[key] = cloneContainer(rightValue);
  }

  return {
    value: result,
    conflicts: Array.from(conflicts).sort()
  };
}

function deepCloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(item => sortKeysDeep(item));
  }
  if (isPlainObject(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function escapeNonAscii(text) {
  return text.replace(/[\u007F-\uFFFF]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

function toPosixPath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

function expandEnvPlaceholders(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_match, name) => {
    const key = String(name || '').trim();
    if (!key) return '';
    return process.env[key] ?? '';
  });
}

function parsePlaceholderSegments(expression) {
  const segments = [];
  let buffer = '';
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (ch === '.') {
      if (buffer) {
        segments.push(buffer);
        buffer = '';
      }
      continue;
    }
    if (ch === '[') {
      if (buffer) {
        segments.push(buffer);
        buffer = '';
      }
      const close = expression.indexOf(']', i + 1);
      if (close === -1) throw new Error(`Unmatched '[' in placeholder: ${expression}`);
      const token = expression.slice(i + 1, close).trim();
      if (!token) throw new Error(`Empty index in placeholder: ${expression}`);
      const numeric = Number.parseInt(token, 10);
      segments.push(Number.isNaN(numeric) ? token : numeric);
      i = close;
      continue;
    }
    buffer += ch;
  }
  if (buffer) segments.push(buffer);
  return segments;
}

function resolvePlaceholder(values, token) {
  try {
    const segments = parsePlaceholderSegments(token);
    return resolveObjectPath(values, segments);
  } catch (err) {
    return { value: undefined, found: false };
  }
}

function formatTemplateString(template, values, options = {}) {
  const fallback = Object.prototype.hasOwnProperty.call(options, 'fallback')
    ? String(options.fallback ?? '')
    : '';
  const missingPolicy = options.missingPolicy === 'error' ? 'error' : 'ignore';
  const missing = [];
  let result = '';

  for (let i = 0; i < template.length; i += 1) {
    const char = template[i];
    if (char === '{') {
      if (template[i + 1] === '{') {
        result += '{';
        i += 1;
        continue;
      }
      const close = template.indexOf('}', i + 1);
      if (close === -1) {
        result += template.slice(i);
        break;
      }
      const token = template.slice(i + 1, close).trim();
      if (!token) {
        missing.push('');
        result += fallback;
        i = close;
        continue;
      }
      const lookup = resolvePlaceholder(values, token);
      if (lookup.found) {
        const value = lookup.value;
        result += value == null ? '' : String(value);
      } else {
        missing.push(token);
        result += fallback;
      }
      i = close;
      continue;
    }
    if (char === '}' && template[i + 1] === '}') {
      result += '}';
      i += 1;
      continue;
    }
    result += char;
  }

  const output = { value: result };
  if (missing.length && missingPolicy === 'ignore') {
    output.missing = missing;
  }
  if (missing.length && missingPolicy === 'error') {
    output.error = {
      code: 'MISSING_PLACEHOLDER',
      message: `Missing placeholders: ${missing.join(', ')}`,
      missingKeys: missing
    };
  }
  return output;
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
  registerState(reg);

  const envGet = async (_ctx, input = {}) => {
    const { name, required = false, expand = false } = input;
    if (!name || typeof name !== 'string') throw new Error('name is required');
    const defaultValue = Object.prototype.hasOwnProperty.call(input, 'default') ? input.default : null;
    const raw = process.env[name];
    const exists = typeof raw === 'string';
    let value = exists ? raw : defaultValue;
    if (required && (value === undefined || value === null)) {
      throw new Error(`environment variable ${name} is not defined`);
    }
    if (typeof value === 'string' && expand) {
      value = expandEnvPlaceholders(value);
    }
    return {
      exists,
      value: value ?? null
    };
  };
  reg.register('lcod://contract/core/env/get@1', envGet);

  const runtimeInfo = async (_ctx, input = {}) => {
    const includePlatform = input.includePlatform !== false;
    const includePid = input.includePid === true;
    const cwd = toPosixPath(process.cwd());
    const tmpDir = toPosixPath(os.tmpdir());
    const home = os.homedir();
    const result = {
      cwd,
      tmpDir,
      homeDir: home ? toPosixPath(home) : null
    };
    if (includePlatform) {
      result.platform = process.platform;
    }
    if (includePid) {
      result.pid = process.pid;
    }
    return result;
  };
  reg.register('lcod://contract/core/runtime/info@1', runtimeInfo);

  // Filesystem contracts
  const fsReadFile = async (_ctx, input = {}) => {
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
  };
  reg.register('lcod://contract/core/fs/read-file@1', fsReadFile);
  reg.register('lcod://contract/core/fs/read_file@1', fsReadFile);

  const fsWriteFile = async (_ctx, input = {}) => {
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
  };
  reg.register('lcod://contract/core/fs/write-file@1', fsWriteFile);
  reg.register('lcod://contract/core/fs/write_file@1', fsWriteFile);

  const fsListDir = async (_ctx, input = {}) => {
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
  };
  reg.register('lcod://contract/core/fs/list-dir@1', fsListDir);
  reg.register('lcod://contract/core/fs/list_dir@1', fsListDir);

  const fsStat = async (_ctx, input = {}) => {
    const target = input.path;
    if (!target) throw new Error('path is required');
    const followSymlinks = input.followSymlinks !== false;
    const absolute = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    try {
      const stats = followSymlinks ? await fs.stat(absolute) : await fs.lstat(absolute);
      return {
        path: toPosixPath(absolute),
        exists: true,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymlink: stats.isSymbolicLink(),
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        ctime: stats.ctime ? stats.ctime.toISOString() : undefined
      };
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return {
          path: toPosixPath(absolute),
          exists: false
        };
      }
      throw err;
    }
  };
  reg.register('lcod://contract/core/fs/stat@1', fsStat);

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

  reg.register('lcod://contract/core/array/append@1', async (_ctx, input = {}) => {
    if (!Array.isArray(input.array)) throw new Error('array must be an array');
    const base = input.array.slice();
    if (Array.isArray(input.items)) {
      base.push(...input.items);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'item')) {
      base.push(input.item);
    }
    return { value: base, length: base.length };
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

  reg.register('lcod://contract/core/object/merge@1', async (_ctx, input = {}) => {
    const left = isPlainObject(input.left) ? input.left : {};
    const right = isPlainObject(input.right) ? input.right : {};
    const deep = input.deep === true;
    const arrayStrategy = input.arrayStrategy;
    const { value, conflicts } = mergePlainObjects(left, right, { deep, arrayStrategy });
    const response = { value };
    if (conflicts.length) response.conflicts = conflicts;
    return response;
  });

  reg.register('lcod://contract/core/object/entries@1', async (_ctx, input = {}) => {
    const object = isPlainObject(input.object) ? input.object : {};
    const entries = Object.entries(object).map(([key, value]) => [key, value]);
    return { entries };
  });

  reg.register('lcod://contract/core/string/format@1', async (_ctx, input = {}) => {
    const template = typeof input.template === 'string' ? input.template : '';
    const values = isPlainObject(input.values) ? input.values : (input.values ?? {});
    const formatted = formatTemplateString(template, values, {
      fallback: Object.prototype.hasOwnProperty.call(input, 'fallback') ? input.fallback : undefined,
      missingPolicy: input.missingPolicy
    });
    return formatted;
  });

  reg.register('lcod://contract/core/string/split@1', async (_ctx, input = {}) => {
    const { text, separator, limit, trim = false, removeEmpty = false } = input;
    if (typeof text !== 'string') throw new Error('text must be a string');
    if (typeof separator !== 'string' || separator.length === 0) {
      throw new Error('separator must be a non-empty string');
    }
    const pieces = typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? text.split(separator, limit)
      : text.split(separator);
    const segments = [];
    for (const part of pieces) {
      const processed = trim ? part.trim() : part;
      if (removeEmpty && processed.length === 0) continue;
      segments.push(processed);
    }
    return { segments };
  });

  reg.register('lcod://contract/core/string/trim@1', async (_ctx, input = {}) => {
    const { text, mode = 'both' } = input;
    if (typeof text !== 'string') throw new Error('text must be a string');
    let value;
    if (mode === 'start') value = text.trimStart();
    else if (mode === 'end') value = text.trimEnd();
    else value = text.trim();
    return { value };
  });

  reg.register('lcod://contract/core/value/kind@1', async (_ctx, input = {}) => {
    const value = Object.prototype.hasOwnProperty.call(input, 'value')
      ? input.value
      : null;
    let kind;
    if (value === null || value === undefined) {
      kind = 'null';
    } else if (Array.isArray(value)) {
      kind = 'array';
    } else {
      const type = typeof value;
      if (type === 'string') kind = 'string';
      else if (type === 'boolean') kind = 'boolean';
      else if (type === 'number') {
        if (!Number.isFinite(value)) throw new Error('value must be finite');
        kind = 'number';
      } else if (type === 'object') {
        kind = 'object';
      } else {
        kind = 'null';
      }
    }
    return { kind };
  });

  reg.register('lcod://contract/core/value/equals@1', async (_ctx, input = {}) => {
    const left = Object.prototype.hasOwnProperty.call(input, 'left') ? input.left : null;
    const right = Object.prototype.hasOwnProperty.call(input, 'right') ? input.right : null;
    return { equal: isDeepStrictEqual(left, right) };
  });

  reg.register('lcod://contract/core/value/clone@1', async (_ctx, input = {}) => {
    const value = Object.prototype.hasOwnProperty.call(input, 'value') ? input.value : null;
    return { value: deepCloneValue(value) };
  });

  reg.register('lcod://contract/core/number/trunc@1', async (_ctx, input = {}) => {
    const { value } = input;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('value must be a finite number');
    }
    return { value: Math.trunc(value) };
  });

  reg.register('lcod://contract/core/json/encode@1', async (_ctx, input = {}) => {
    const sortKeys = input.sortKeys === true;
    const asciiOnly = input.asciiOnly === true;
    const space = typeof input.space === 'number' ? Math.min(Math.max(input.space, 0), 10) : 0;
    try {
      const value = sortKeys ? sortKeysDeep(input.value) : input.value;
      let text = JSON.stringify(value, null, space);
      if (asciiOnly && typeof text === 'string') {
        text = escapeNonAscii(text);
      }
      return { text, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (err) {
      return {
        error: {
          code: 'UNSERIALISABLE',
          message: err?.message || 'Unable to encode value'
        }
      };
    }
  });

  reg.register('lcod://contract/core/json/decode@1', async (_ctx, input = {}) => {
    if (typeof input.text !== 'string') throw new Error('text must be a string');
    const text = input.text;
    try {
      const value = JSON.parse(text);
      return { value, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (err) {
      const match = /position (\d+)/i.exec(err.message || '');
      return {
        error: {
          code: 'JSON_PARSE',
          message: err.message || 'Invalid JSON',
          offset: match ? Number.parseInt(match[1], 10) : undefined
        }
      };
    }
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
  aliasContract('lcod://contract/core/array/append@1', 'lcod://axiom/array/append@1');
  aliasContract('lcod://contract/core/object/get@1', 'lcod://axiom/object/get@1');
  aliasContract('lcod://contract/core/object/set@1', 'lcod://axiom/object/set@1');
  aliasContract('lcod://contract/core/object/merge@1', 'lcod://axiom/object/merge@1');
  aliasContract('lcod://contract/core/string/format@1', 'lcod://axiom/string/format@1');
  aliasContract('lcod://contract/core/json/encode@1', 'lcod://axiom/json/encode@1');
  aliasContract('lcod://contract/core/json/decode@1', 'lcod://axiom/json/decode@1');

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
