#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { Registry, Context } from '../src/registry.js';
import { registerNodeCore, registerNodeResolverAxioms } from '../src/core/index.js';
import { registerDemoAxioms } from '../src/axioms.js';
import { registerFlowPrimitives } from '../src/flow/register.js';
import { registerTooling } from '../src/tooling/index.js';
import { registerRegistryComponents } from '../src/tooling/registry-components.js';
import { runCompose } from '../src/compose.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.set('json', true);
    } else if (arg === '--manifest') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--manifest requires a path argument');
      }
      args.set('manifest', value);
      i += 1;
    }
  }
  return args;
}

async function locateSpecRepo() {
  if (process.env.SPEC_REPO_PATH) {
    return process.env.SPEC_REPO_PATH;
  }
  const candidates = [
    path.resolve(__dirname, '../lcod-spec'),
    path.resolve(__dirname, '../../lcod-spec'),
    path.resolve(process.cwd(), '../lcod-spec'),
    path.resolve(process.cwd(), '../../lcod-spec')
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch (_) {
      // ignore
    }
  }
  throw new Error('Unable to locate lcod-spec repository. Set SPEC_REPO_PATH.');
}

async function loadCompose(filepath) {
  const text = await fs.readFile(filepath, 'utf8');
  const doc = YAML.parse(text);
  if (!doc || !Array.isArray(doc.compose)) {
    throw new Error(`Compose file does not contain a compose array: ${filepath}`);
  }
  return doc.compose;
}

async function runTest(composePath) {
  const composeDir = path.dirname(composePath);
  const originalCwd = process.cwd();
  process.chdir(composeDir);
  try {
    const compose = await loadCompose(composePath);
    const baseRegistry = registerNodeCore(new Registry());
    registerNodeResolverAxioms(baseRegistry);
    const registry = registerTooling(
      registerFlowPrimitives(registerDemoAxioms(baseRegistry))
    );
    await registerRegistryComponents(registry);
    const ctx = new Context(registry);
    const result = await runCompose(ctx, compose, {});
    const report = result.report || {};
    return {
      success: Boolean(report.success),
      report,
      result
    };
  } finally {
    process.chdir(originalCwd);
  }
}

async function loadManifest(specRoot, manifestPath) {
  if (!manifestPath) return null;
  const abs = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(specRoot, manifestPath);
  const text = await fs.readFile(abs, 'utf8');
  const entries = JSON.parse(text);
  return entries.map((entry) => ({
    name: entry.name,
    compose: path.isAbsolute(entry.compose)
      ? entry.compose
      : path.join(specRoot, entry.compose)
  }));
}

(async () => {
  const args = parseArgs(process.argv);
  const specRoot = await locateSpecRepo();
  const manifestEntries = await loadManifest(specRoot, args.get('manifest'));
  const results = [];

  if (manifestEntries) {
    for (const entry of manifestEntries) {
      try {
        const outcome = await runTest(entry.compose);
        results.push({ name: entry.name, ...outcome });
      } catch (err) {
        results.push({ name: entry.name, success: false, error: err });
      }
    }
  } else {
    const testsRoot = path.join(specRoot, 'tests/spec');
    const entries = await fs.readdir(testsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const composePath = path.join(testsRoot, entry.name, 'compose.yaml');
      try {
        await fs.access(composePath);
      } catch (_) {
        continue;
      }
      try {
        const outcome = await runTest(composePath);
        results.push({ name: entry.name, ...outcome });
      } catch (err) {
        results.push({ name: entry.name, success: false, error: err });
      }
    }
  }

  const failures = results.filter((res) => !res.success).length;

  if (args.get('json')) {
    const serialisable = results.map((res) => ({
      name: res.name,
      success: res.success,
      report: res.report ?? null,
      result: res.result ?? null,
      error: res.error ? { message: res.error.message } : null
    }));
    console.log(JSON.stringify(serialisable, null, 2));
    process.exit(failures === 0 ? 0 : 1);
  }

  if (!results.length) {
    console.warn('No spec tests were discovered.');
  }

  for (const res of results) {
    if (res.success) {
      console.log(`✅ ${res.name}`);
    } else {
      const messages = res.error
        ? [res.error.message]
        : res.report?.messages || [];
      const diff = res.report?.diffs?.[0];
      const diffLabel = diff ? ` (diff: expected ${diff.expected}, actual ${diff.actual})` : '';
      const suffix = messages.length ? ` — ${messages.join('\n')}${diffLabel}` : diffLabel;
      console.error(`❌ ${res.name}${suffix}`);
    }
  }

  process.exit(failures === 0 ? 0 : 1);
})();
