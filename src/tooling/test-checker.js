import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, inspect } from 'node:util';
import YAML from 'yaml';

import { Context } from '../registry.js';
import { runCompose } from '../compose.js';

function ensureComposeDefinition(input) {
  if (Array.isArray(input.compose)) {
    return Promise.resolve(input.compose);
  }
  const ref = input.composeRef;
  if (!ref || typeof ref.path !== 'string') {
    throw new Error('compose or composeRef.path must be provided');
  }
  const resolved = path.resolve(process.cwd(), ref.path);
  return fs.readFile(resolved, 'utf8')
    .then(text => {
      const doc = YAML.parse(text);
      if (!doc || !Array.isArray(doc.compose)) {
        throw new Error(`composeRef path does not contain a compose array: ${resolved}`);
      }
      return doc.compose;
    });
}

function cloneBindings(registry) {
  return { ...(registry.bindings || {}) };
}

function applyBindings(registry, bindings) {
  if (!Array.isArray(bindings)) return;
  const map = {};
  for (const entry of bindings) {
    if (entry && typeof entry.contract === 'string' && typeof entry.implementation === 'string') {
      map[entry.contract] = entry.implementation;
    }
  }
  if (Object.keys(map).length) {
    registry.setBindings(map);
  }
}

function simpleDiff(actual, expected) {
  return [
    {
      path: '$',
      actual: inspect(actual, { depth: 5 }),
      expected: inspect(expected, { depth: 5 })
    }
  ];
}

function setDeepValue(target, pathString, value) {
  if (!pathString) return;
  const parts = pathString.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cursor[key] == null || typeof cursor[key] !== 'object') {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function decodeChunk(chunk, encoding) {
  if (encoding === 'base64') return Buffer.from(chunk, 'base64');
  if (encoding === 'hex') return Buffer.from(chunk, 'hex');
  return Buffer.from(chunk, encoding === 'utf-8' ? 'utf8' : encoding);
}

function registerStreams(ctx, initialState, specs = []) {
  if (!Array.isArray(specs) || !specs.length) return;
  for (const spec of specs) {
    if (!spec || typeof spec.target !== 'string' || !Array.isArray(spec.chunks)) continue;
    const encoding = typeof spec.encoding === 'string' ? spec.encoding.toLowerCase() : 'utf-8';
    const decoded = spec.chunks.map(chunk => decodeChunk(String(chunk ?? ''), encoding));
    const handle = ctx.streams.createFromAsyncGenerator(async function* () {
      for (const chunk of decoded) {
        yield chunk;
      }
    }, { encoding });
    if (typeof initialState === 'object' && initialState !== null) {
      setDeepValue(initialState, spec.target, handle);
    }
  }
}

function matchesExpected(actual, expected) {
  if (isDeepStrictEqual(actual, expected)) return true;
  if (
    expected &&
    typeof expected === 'object' &&
    !Array.isArray(expected) &&
    actual &&
    typeof actual === 'object' &&
    !Array.isArray(actual)
  ) {
    for (const key of Object.keys(expected)) {
      if (!matchesExpected(actual[key], expected[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

export function registerTestChecker(registry) {
  registry.register('lcod://tooling/test_checker@1', async (ctx, input = {}) => {
    const expected = input.expected;
    if (typeof expected === 'undefined') {
      throw new Error('expected output is required');
    }

    const composePromise = ensureComposeDefinition(input);
    const initialState = input.input && typeof input.input === 'object' && !Array.isArray(input.input)
      ? (typeof structuredClone === 'function' ? structuredClone(input.input) : JSON.parse(JSON.stringify(input.input)))
      : (typeof input.input === 'undefined' ? {} : input.input);
    const failFast = input.failFast !== undefined ? Boolean(input.failFast) : true;

    const registrySnapshot = cloneBindings(ctx.registry);
    applyBindings(ctx.registry, input.bindings);

    const childCtx = new Context(ctx.registry);
    if (typeof initialState === 'object' && initialState !== null) {
      registerStreams(childCtx, initialState, input.streams);
    }

    let compose;
    try {
      compose = await composePromise;
    } catch (err) {
      ctx.registry.bindings = registrySnapshot;
      return {
        success: false,
        expected,
        actual: undefined,
        messages: [`Failed to load compose: ${err.message}`]
      };
    }

    const start = performance.now();
    let actual;
    let success = false;
    const messages = [];
    let diffs = undefined;

    try {
      actual = await runCompose(childCtx, compose, initialState);
      success = matchesExpected(actual, expected);
      if (!success) {
        messages.push('Actual output differs from expected output');
        diffs = simpleDiff(actual, expected);
      }
    } catch (err) {
      messages.push(`Compose execution failed: ${err.message}`);
      actual = { error: { message: err.message, stack: err.stack } };
      success = false;
    } finally {
      ctx.registry.bindings = registrySnapshot;
    }

    const durationMs = performance.now() - start;

    const report = {
      success,
      actual,
      expected,
      durationMs,
      messages
    };

    if (!success && diffs && !failFast) {
      report.diffs = diffs;
    } else if (!success && failFast) {
      report.diffs = diffs ? [diffs[0]] : undefined;
    } else if (!success) {
      report.diffs = diffs;
    }

    return report;
  });

  return registry;
}
