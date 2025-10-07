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

  return reg;
}

export function registerNodeResolverAxioms(reg) {
  const deepClone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

  const resolveDependencyRecursive = async (ctx, dependency, config, projectPath, stack, cache, warnings) => {
    if (cache.has(dependency)) return cache.get(dependency);
    if (stack.includes(dependency)) {
      const cycle = [...stack, dependency].join(' -> ');
      throw new Error(`Dependency cycle detected: ${cycle}`);
    }

    const nextStack = [...stack, dependency];
    const sources = config?.sources && typeof config.sources === 'object' ? config.sources : {};
    let sourceSpec = sources[dependency];
    if (!sourceSpec) {
      const resolvedFallback = {
        id: dependency,
        source: { type: 'registry', reference: dependency },
        dependencies: []
      };
      cache.set(dependency, resolvedFallback);
      return resolvedFallback;
    }

    sourceSpec = deepClone(sourceSpec);
    const dependencies = [];
    let integrity = null;
    let resolvedSource = null;

    const processDescriptor = async (descriptorPath, descriptorText) => {
      let descriptor;
      try {
        descriptor = parseToml(descriptorText);
      } catch (err) {
        warnings.push(`Failed to parse ${descriptorPath} for ${dependency}: ${err.message}`);
        return;
      }
      const childIds = Array.isArray(descriptor?.deps?.requires) ? descriptor.deps.requires : [];
      for (const child of childIds) {
        if (typeof child !== 'string' || child.length === 0) continue;
        const resolvedChild = await resolveDependencyRecursive(ctx, child, config, projectPath, nextStack, cache, warnings);
        dependencies.push(resolvedChild);
      }
    };

    if (sourceSpec.type === 'path') {
      const sourcePath = typeof sourceSpec.path === 'string' ? sourceSpec.path : '.';
      const absPath = path.isAbsolute(sourcePath)
        ? sourcePath
        : path.resolve(projectPath, sourcePath);
      resolvedSource = { type: 'path', path: absPath };
      const descriptorPath = path.join(absPath, 'lcp.toml');
      let descriptorText = null;
      try {
        descriptorText = await fs.readFile(descriptorPath, 'utf8');
      } catch (err) {
        warnings.push(`Failed to load ${descriptorPath} for ${dependency}: ${err.message}`);
      }
      if (descriptorText != null) {
        integrity = integrityFromBuffer(Buffer.from(descriptorText, 'utf8'));
        await processDescriptor(descriptorPath, descriptorText);
      }
    } else if (sourceSpec.type === 'git') {
      const url = typeof sourceSpec.url === 'string' ? sourceSpec.url : null;
      if (!url) {
        warnings.push(`Missing git url for ${dependency}; defaulting to registry reference.`);
        resolvedSource = { type: 'registry', reference: dependency };
      } else {
        const ref = sourceSpec.ref || sourceSpec.rev || null;
        const subdir = sourceSpec.subdir || null;
        const depth = sourceSpec.depth;
        const cacheRoot = await ensureCacheDir(projectPath);
        const cacheKey = computeCacheKey({ type: 'git', dependency, url, ref, subdir });
        const repoBase = path.join(cacheRoot, 'git', cacheKey);
        await fs.mkdir(repoBase, { recursive: true });
        const descriptorRoot = subdir ? path.join(repoBase, subdir) : repoBase;
        const descriptorPath = path.join(descriptorRoot, 'lcp.toml');
        let needClone = Boolean(sourceSpec.force);
        try {
          await fs.access(descriptorPath);
        } catch {
          needClone = true;
        }

        let commit = sourceSpec.commit || null;
        let fetchedAt = null;
        const metadataPath = path.join(repoBase, '.lcod-source.json');

        if (needClone) {
          await fs.rm(repoBase, { recursive: true, force: true });
          await fs.mkdir(path.dirname(repoBase), { recursive: true });
          const cloneInput = { url, dest: repoBase };
          if (ref) cloneInput.ref = ref;
          if (depth) cloneInput.depth = depth;
          if (subdir) cloneInput.subdir = subdir;
          if (sourceSpec.auth) cloneInput.auth = sourceSpec.auth;
          try {
            const cloneResult = await ctx.call('lcod://contract/core/git/clone@1', cloneInput);
            if (cloneResult && typeof cloneResult === 'object') {
              commit = cloneResult.commit || commit;
              fetchedAt = cloneResult?.source?.fetchedAt || new Date().toISOString();
            }
          } catch (err) {
            warnings.push(`Failed to clone ${url} for ${dependency}: ${err.message}`);
          }
          if (commit) {
            const metadata = {
              url,
              commit,
              ref: ref || null,
              fetchedAt: fetchedAt || new Date().toISOString(),
              subdir: subdir || null
            };
            await fs.mkdir(path.dirname(metadataPath), { recursive: true });
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
          }
        } else {
          try {
            const metadataText = await fs.readFile(metadataPath, 'utf8');
            const metadata = JSON.parse(metadataText);
            commit = metadata.commit || commit;
            fetchedAt = metadata.fetchedAt || fetchedAt;
          } catch {
            // best-effort metadata read
          }
        }

        let descriptorText = null;
        try {
          descriptorText = await fs.readFile(descriptorPath, 'utf8');
        } catch (err) {
          warnings.push(`Failed to load ${descriptorPath} for ${dependency}: ${err.message}`);
        }
        if (descriptorText != null) {
          integrity = integrityFromBuffer(Buffer.from(descriptorText, 'utf8'));
          await processDescriptor(descriptorPath, descriptorText);
        }

        resolvedSource = {
          type: 'git',
          url,
          path: descriptorRoot
        };
        if (ref) resolvedSource.ref = ref;
        if (commit) resolvedSource.commit = commit;
        if (fetchedAt) resolvedSource.fetchedAt = fetchedAt;
      }
    } else if (sourceSpec.type === 'http') {
      const url = typeof sourceSpec.url === 'string' ? sourceSpec.url : null;
      if (!url) {
        warnings.push(`Missing http url for ${dependency}; defaulting to registry reference.`);
        resolvedSource = { type: 'registry', reference: dependency };
      } else {
        const cacheRoot = await ensureCacheDir(projectPath);
        const cacheKey = computeCacheKey({ type: 'http', dependency, url, method: sourceSpec.method || 'GET' });
        const targetDir = path.join(cacheRoot, 'http', cacheKey);
        await fs.mkdir(targetDir, { recursive: true });
        const defaultName = (() => {
          try {
            const urlObj = new URL(url);
            const base = path.basename(urlObj.pathname);
            return base && base !== '/' ? base : 'artifact';
          } catch {
            return 'artifact';
          }
        })();
        const filename = typeof sourceSpec.filename === 'string' && sourceSpec.filename.length > 0 ? sourceSpec.filename : defaultName;
        const targetPath = path.join(targetDir, filename);
        let needDownload = Boolean(sourceSpec.force);
        if (!needDownload) {
          try {
            await fs.access(targetPath);
          } catch {
            needDownload = true;
          }
        }
        if (needDownload) {
          const downloadInput = { url, path: targetPath };
          for (const key of ['method', 'headers', 'query', 'timeoutMs', 'followRedirects', 'body', 'bodyEncoding']) {
            if (sourceSpec[key] !== undefined) downloadInput[key] = sourceSpec[key];
          }
          try {
            await ctx.call('lcod://axiom/http/download@1', downloadInput);
          } catch (err) {
            warnings.push(`Failed to download ${url} for ${dependency}: ${err.message}`);
          }
        }
        const descriptorRel = typeof sourceSpec.descriptorPath === 'string' && sourceSpec.descriptorPath.length > 0
          ? sourceSpec.descriptorPath
          : '';
        const descriptorPath = descriptorRel ? path.join(targetDir, descriptorRel) : targetPath;
        let descriptorText = null;
        try {
          descriptorText = await fs.readFile(descriptorPath, 'utf8');
        } catch (err) {
          warnings.push(`Failed to load ${descriptorPath} for ${dependency}: ${err.message}`);
        }
        if (descriptorText != null) {
          integrity = integrityFromBuffer(Buffer.from(descriptorText, 'utf8'));
          await processDescriptor(descriptorPath, descriptorText);
        }
        resolvedSource = {
          type: 'http',
          url,
          path: descriptorRel ? path.dirname(descriptorPath) : descriptorPath
        };
      }
    } else if (typeof sourceSpec.type !== 'string') {
      warnings.push(`Unknown source type for ${dependency}; defaulting to registry reference.`);
      resolvedSource = { type: 'registry', reference: dependency };
    } else {
      resolvedSource = sourceSpec;
    }

    const resolved = { id: dependency, source: resolvedSource, dependencies };
    if (integrity) resolved.integrity = integrity;
    cache.set(dependency, resolved);
    return resolved;
  };

  const aliasContract = (contractId, axiomId) => {
    const entry = reg.get(contractId);
    if (!entry) throw new Error(`Contract not registered: ${contractId}`);
    reg.register(axiomId, entry.fn, {
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      implements: entry.implements
    });
  };

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
    const response = await fetch(url, init);
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

  reg.register('lcod://contract/tooling/resolve-dependency@1', async (_ctx, input = {}) => {
    const dependency = input.dependency;
    if (typeof dependency !== 'string' || dependency.length === 0) {
      throw new Error('dependency is required');
    }
    const config = input.config && typeof input.config === 'object' ? input.config : {};
    const projectPath = input.projectPath ? path.resolve(input.projectPath) : process.cwd();
    const stack = Array.isArray(input.stack) ? input.stack.map(String) : [];
    const cache = new Map();
    const warnings = [];
    const resolved = await resolveDependencyRecursive(_ctx, dependency, config, projectPath, stack, cache, warnings);
    return {
      resolved,
      warnings
    };
  });

  reg.register('lcod://impl/set@1', async (_ctx, input = {}) => ({ ...input }));

  return reg;
}
