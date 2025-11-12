import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clonePlainObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function normaliseObject(value) {
  return isPlainObject(value) ? value : {};
}

function normalisePath(value) {
  return Array.isArray(value) ? value : [];
}

function isDefined(value) {
  return value !== undefined && value !== null;
}

function toNonEmptyString(value) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function canonicalise(value, stack) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (stack.has(value)) {
    throw new TypeError('Cannot stringify cyclic structures');
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalise(entry, stack));
    }
    const ordered = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      ordered[key] = canonicalise(value[key], stack);
    }
    return ordered;
  } finally {
    stack.delete(value);
  }
}

function stableStringify(value) {
  const canonical = canonicalise(value, new WeakSet());
  return JSON.stringify(canonical);
}

function createHashKey(text, prefix) {
  const digest = createHash('sha256').update(text, 'utf8').digest('base64');
  return prefix ? `${prefix}${digest}` : digest;
}

function toTrimmedString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function appendChildren(queue, children) {
  if (!Array.isArray(children)) return;
  for (const child of children) {
    queue.push(child);
  }
}

function collectWarnings(target, warnings) {
  if (!Array.isArray(warnings)) return;
  for (const warning of warnings) {
    if (typeof warning === 'string' && warning.length > 0) {
      target.push(warning);
    }
  }
}

function normalizeRegistrySourceEntry(entry) {
  const warnings = [];
  const id = toTrimmedString(entry.id);
  if (!id) {
    warnings.push('registry source entry is missing an id');
    return { entry: null, warnings };
  }

  const type = toTrimmedString(entry.type) || 'path';
  const normalized = { id, type };

  if (Number.isFinite(entry.priority)) {
    normalized.priority = Math.trunc(entry.priority);
  }
  if (isPlainObject(entry.defaults)) {
    normalized.defaults = entry.defaults;
  }
  const registryPath = toTrimmedString(entry.registryPath);
  if (registryPath) {
    normalized.registryPath = registryPath;
  }
  const packagesPath = toTrimmedString(entry.packagesPath);
  if (packagesPath) {
    normalized.packagesPath = packagesPath;
  }

  if (type === 'path') {
    const pathValue = toTrimmedString(entry.path);
    if (!pathValue) {
      warnings.push(`registry source "${id}" (type=path) is missing "path"`);
      return { entry: null, warnings };
    }
    normalized.path = pathValue;
    return { entry: normalized, warnings };
  }

  if (type === 'jsonl') {
    const pathValue = toTrimmedString(entry.path);
    const inlineJsonl = toTrimmedString(entry.jsonl);
    if (pathValue) {
      normalized.path = pathValue;
      return { entry: normalized, warnings };
    }
    if (inlineJsonl) {
      normalized.jsonl = inlineJsonl;
      return { entry: normalized, warnings };
    }
    warnings.push(`registry source "${id}" (type=jsonl) is missing "path" or inline "jsonl" content`);
    return { entry: null, warnings };
  }

  if (type === 'inline') {
    const lines = Array.isArray(entry.lines)
      ? entry.lines.filter((candidate) => isPlainObject(candidate)).map((candidate) => ({ ...candidate }))
      : [];
    if (!lines.length) {
      warnings.push(`registry source "${id}" (type=inline) is missing "lines" entries`);
      return { entry: null, warnings };
    }
    normalized.lines = lines;
    const inlineJsonl = toTrimmedString(entry.jsonl);
    if (inlineJsonl) {
      normalized.jsonl = inlineJsonl;
    }
    return { entry: normalized, warnings };
  }

  warnings.push(`registry source "${id}" has unsupported type "${type}"`);
  return { entry: null, warnings };
}

async function jsonlReadHelper(_ctx, input = {}) {
  const pathValue = typeof input.path === 'string' && input.path.length ? input.path : null;
  const urlValue = typeof input.url === 'string' && input.url.length ? input.url : null;
  if (!pathValue) {
    if (urlValue) {
      throw new Error('jsonl/read does not support url inputs yet');
    }
    throw new Error('jsonl/read requires `path`');
  }

  const encodingRaw = typeof input.encoding === 'string' && input.encoding.length ? input.encoding : 'utf8';
  const normalizedEncoding = encodingRaw.toLowerCase();
  if (normalizedEncoding !== 'utf8' && normalizedEncoding !== 'utf-8') {
    throw new Error(`jsonl/read only supports utf-8 encoding (got ${encodingRaw})`);
  }

  let raw;
  try {
    raw = await fs.readFile(pathValue, { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`jsonl/read failed to read ${pathValue}: ${err?.message || err}`);
  }

  const entries = [];
  const warnings = [];
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      warnings.push(`invalid JSONL entry at ${pathValue}:${index + 1}: ${err?.message || err}`);
    }
  }

  return { entries, warnings };
}

const visitedKeyPrefix = 'item:';

async function queueBfsHelper(ctx, input = {}) {
  const queue = Array.isArray(input.items) ? [...input.items] : [];
  const visitedMap = isPlainObject(input.visited) ? { ...input.visited } : {};
  const visited = new Set(Object.keys(visitedMap));
  let state = isPlainObject(input.state) ? { ...input.state } : {};
  const contextValue = Object.prototype.hasOwnProperty.call(input, 'context')
    ? input.context
    : undefined;

  const maxIterations = Number.isFinite(input.maxIterations) && input.maxIterations > 0
    ? Math.trunc(input.maxIterations)
    : Number.POSITIVE_INFINITY;

  const warnings = [];
  let iterations = 0;

  while (queue.length > 0) {
    ctx.ensureNotCancelled();
    if (iterations >= maxIterations) {
      throw new Error(`queue/bfs exceeded maxIterations (${maxIterations})`);
    }

    const item = queue.shift();
    const slotVars = {
      index: iterations,
      remaining: queue.length,
      visitedCount: visited.size,
      item,
      state,
      context: contextValue
    };

    let keyValue = null;
    if (typeof ctx.runSlot === 'function') {
      try {
        const candidate = await ctx.runSlot(
          'key',
          { item, state, context: contextValue },
          slotVars
        );
        if (typeof candidate === 'string' && candidate.length > 0) {
          keyValue = candidate;
        }
      } catch (err) {
        warnings.push(`queue/bfs key slot failed: ${err?.message || String(err)}`);
      }
    }

    if (!keyValue) {
      try {
        keyValue = JSON.stringify(item);
      } catch (err) {
        warnings.push(`queue/bfs fallback key serialization failed: ${err?.message || String(err)}`);
        keyValue = `${visitedKeyPrefix}${iterations}`;
      }
    }

    if (visited.has(keyValue)) {
      iterations += 1;
      continue;
    }
    visited.add(keyValue);
    visitedMap[keyValue] = true;

    let processResult = {};
    if (typeof ctx.runSlot === 'function') {
      const result = await ctx.runSlot(
        'process',
        { item, state, context: contextValue },
        slotVars
      );
      if (result && typeof result === 'object') {
        processResult = result;
      }
    }

    appendChildren(queue, processResult.children);
    if (isPlainObject(processResult.state)) {
      state = processResult.state;
    }
    collectWarnings(warnings, processResult.warnings);

    iterations += 1;
  }

  return {
    state,
    visited: visitedMap,
    warnings,
    iterations
  };
}

export function registerStdHelpers(registry) {
  const valueIsDefined = async (_ctx, input = {}) => {
    const hasKey = Object.prototype.hasOwnProperty.call(input, 'value');
    const ok = hasKey && isDefined(input.value);
    return { ok };
  };

  registry.register('lcod://contract/tooling/value/is_defined@1', valueIsDefined);
  registry.register('lcod://tooling/value/is_defined@0.1.0', valueIsDefined);

  const ensureTrailingNewline = async (_ctx, input = {}) => {
    const text = typeof input.text === 'string' ? input.text : '';
    const newline =
      typeof input.newline === 'string' && input.newline.length > 0 ? input.newline : '\n';
    if (newline.length === 0 || text.endsWith(newline)) {
      return { text };
    }
    return { text: `${text}${newline}` };
  };

  registry.register('lcod://contract/tooling/string/ensure_trailing_newline@1', ensureTrailingNewline);
  registry.register('lcod://tooling/string/ensure_trailing_newline@0.1.0', ensureTrailingNewline);

  const arrayCompact = async (_ctx, input = {}) => {
    const source = Array.isArray(input.items) ? input.items : [];
    const values = source.filter((item) => item !== null && item !== undefined);
    return { values };
  };
  registry.register('lcod://contract/tooling/array/compact@1', arrayCompact);
  registry.register('lcod://tooling/array/compact@0.1.0', arrayCompact);

  const arrayFlatten = async (_ctx, input = {}) => {
    const source = Array.isArray(input.items) ? input.items : [];
    const values = [];
    for (const entry of source) {
      if (Array.isArray(entry)) {
        values.push(...entry);
      } else if (entry !== null && entry !== undefined) {
        values.push(entry);
      }
    }
    return { values };
  };
  registry.register('lcod://contract/tooling/array/flatten@1', arrayFlatten);
  registry.register('lcod://tooling/array/flatten@0.1.0', arrayFlatten);

  const arrayFindDuplicates = async (_ctx, input = {}) => {
    const source = Array.isArray(input.items) ? input.items : [];
    const seen = new Set();
    const duplicates = new Set();
    for (const entry of source) {
      if (typeof entry !== 'string') continue;
      if (seen.has(entry)) {
        duplicates.add(entry);
      } else {
        seen.add(entry);
      }
    }
    return { duplicates: Array.from(duplicates) };
  };
  registry.register('lcod://contract/tooling/array/find_duplicates@1', arrayFindDuplicates);
  registry.register('lcod://tooling/array/find_duplicates@0.1.0', arrayFindDuplicates);

  const arrayAppend = async (_ctx, input = {}) => {
    const clone = input.clone !== false;
    const source = Array.isArray(input.items) ? input.items : [];
    const target = clone ? source.slice() : source;
    if (Array.isArray(input.values)) {
      target.push(...input.values);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'value')) {
      target.push(input.value);
    }
    return { items: target, length: target.length };
  };
  registry.register('lcod://contract/tooling/array/append@1', arrayAppend);
  registry.register('lcod://tooling/array/append@0.1.0', arrayAppend);

  const pathJoinChain = async (_ctx, input = {}) => {
    let current = typeof input.base === 'string' && input.base.length > 0 ? input.base : '';
    const segments = Array.isArray(input.segments) ? input.segments : [];
    for (const segment of segments) {
      if (segment === null || segment === undefined) continue;
      const segmentStr = String(segment);
      if (!segmentStr.length) continue;
      current = current ? path.join(current, segmentStr) : segmentStr;
    }
    const normalized = current ? path.normalize(current).replace(/\\/g, '/') : '';
    return { path: normalized };
  };
  registry.register('lcod://contract/tooling/path/join_chain@1', pathJoinChain);
  registry.register('lcod://tooling/path/join_chain@0.1.0', pathJoinChain);
  registry.register('lcod://contract/tooling/jsonl/read@1', jsonlReadHelper);
  registry.register('lcod://contract/tooling/jsonl/read@1.0.0', jsonlReadHelper);
  registry.register('lcod://tooling/jsonl/read@0.1.0', jsonlReadHelper);

  registry.register('lcod://contract/tooling/fs/read_optional@1', async (_ctx, input = {}) => {
    const encoding = toNonEmptyString(input.encoding) || 'utf-8';
    const pathValue = toNonEmptyString(input.path);
    const fallbackText = toNonEmptyString(input.fallback);
    const warningMessage = toNonEmptyString(input.warningMessage);

    if (!pathValue) {
      return { text: fallbackText ?? null, exists: false, warning: warningMessage ?? null };
    }

    try {
      const data = await fs.readFile(pathValue, { encoding });
      return { text: typeof data === 'string' ? data : null, exists: true, warning: null };
    } catch (err) {
      if (fallbackText != null) {
        return { text: fallbackText, exists: false, warning: warningMessage ?? null };
      }
      const warning =
        warningMessage ?? err?.message ?? (typeof err === 'string' ? err : String(err));
      return { text: null, exists: false, warning };
    }
  });

  registry.register('lcod://contract/tooling/fs/write_if_changed@1', async (_ctx, input = {}) => {
    const pathValue = typeof input.path === 'string' && input.path.length > 0 ? input.path : null;
    if (!pathValue) {
      throw new Error('write_if_changed: path is required');
    }
    const encoding = toNonEmptyString(input.encoding) || 'utf-8';
    let content;
    if (typeof input.content === 'string') {
      content = input.content;
    } else if (!isDefined(input.content)) {
      content = '';
    } else {
      content = String(input.content);
    }

    let previous = null;
    try {
      previous = await fs.readFile(pathValue, { encoding });
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }

    if (previous === content) {
      return { changed: false };
    }

    await fs.writeFile(pathValue, content, { encoding });
    return { changed: true };
  });

  registry.register('lcod://tooling/object/clone@0.1.0', async (_ctx, input = {}) => {
    if (!isPlainObject(input.value)) {
      return { clone: {} };
    }
    return { clone: clonePlainObject(input.value) };
  });

  registry.register('lcod://tooling/object/set@0.1.0', async (_ctx, input = {}) => {
    const target = normaliseObject(input.target);
    const updated = clonePlainObject(target);
    const previous = target;
    const path = normalisePath(input.path);

    if (path.length === 0) {
      return { object: input.value, previous };
    }

    let cursor = updated;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i];
      if (typeof segment !== 'string' || segment.length === 0) {
        continue;
      }
      if (!isPlainObject(cursor[segment])) {
        cursor[segment] = {};
      }
      cursor = cursor[segment];
    }

    const lastKey = path[path.length - 1];
    if (typeof lastKey === 'string' && lastKey.length > 0) {
      cursor[lastKey] = input.value;
    }

    return { object: updated, previous };
  });

  registry.register('lcod://tooling/object/has@0.1.0', async (_ctx, input = {}) => {
    const target = normaliseObject(input.target);
    const path = normalisePath(input.path);
    if (path.length === 0) {
      return { hasKey: false, value: undefined };
    }

    let cursor = target;
    for (let i = 0; i < path.length; i += 1) {
      const segment = path[i];
      if (typeof segment !== 'string' || segment.length === 0) {
        return { hasKey: false, value: undefined };
      }
      if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
        return { hasKey: false, value: undefined };
      }
      const next = cursor[segment];
      if (i === path.length - 1) {
        return { hasKey: true, value: next };
      }
      if (!isPlainObject(next)) {
        return { hasKey: false, value: undefined };
      }
      cursor = next;
    }
    return { hasKey: false, value: undefined };
  });

  const jsonStableStringify = async (_ctx, input = {}) => {
    try {
      const text = stableStringify(input.value);
      return { text, warning: null };
    } catch (err) {
      return { text: null, warning: err?.message || String(err) };
    }
  };
  registry.register('lcod://contract/tooling/json/stable_stringify@1', jsonStableStringify);
  registry.register('lcod://tooling/json/stable_stringify@0.1.0', jsonStableStringify);

  const hashToKey = async (_ctx, input = {}) => {
    const text = typeof input.text === 'string' ? input.text : '';
    const prefix = typeof input.prefix === 'string' ? input.prefix : '';
    const key = createHashKey(text, prefix);
    return { key };
  };
  registry.register('lcod://contract/tooling/hash/to_key@1', hashToKey);
  registry.register('lcod://tooling/hash/to_key@0.1.0', hashToKey);

  const registryNormalizeSource = async (_ctx, input = {}) => {
    if (!isPlainObject(input.entry)) {
      return { entry: null, warnings: [] };
    }
    return normalizeRegistrySourceEntry(input.entry);
  };
  registry.register(
    'lcod://contract/tooling/registry/normalize_source@1',
    registryNormalizeSource
  );

  const registryNormalizeSources = async (_ctx, input = {}) => {
    const entries = Array.isArray(input.entries) ? input.entries : [];
    const normalizedEntries = [];
    const warnings = [];
    for (const rawEntry of entries) {
      if (!isPlainObject(rawEntry)) continue;
      const result = normalizeRegistrySourceEntry(rawEntry);
      collectWarnings(warnings, result.warnings);
      if (result.entry) {
        normalizedEntries.push(result.entry);
      }
    }
    return { entries: normalizedEntries, warnings };
  };
  registry.register(
    'lcod://contract/tooling/registry/normalize_sources@1',
    registryNormalizeSources
  );

  registry.register('lcod://contract/tooling/queue/bfs@1', queueBfsHelper);
  registry.register('lcod://tooling/queue/bfs@0.1.0', queueBfsHelper);
}
