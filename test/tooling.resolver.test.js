import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { Registry, Context } from '../src/registry.js';
import { runCompose } from '../src/compose.js';
import { registerNodeCore, registerNodeResolverAxioms } from '../src/core/index.js';
import { flowIf } from '../src/flow/if.js';
import { flowForeach } from '../src/flow/foreach.js';
import { flowParallel } from '../src/flow/parallel.js';
import { flowTry } from '../src/flow/try.js';
import { flowThrow } from '../src/flow/throw.js';
import { flowBreak } from '../src/flow/break.js';
import { flowContinue } from '../src/flow/continue.js';

async function resolveSpecRoot() {
  const override = process.env.SPEC_REPO_PATH;
  if (override) {
    const abs = path.resolve(override);
    if (await dirExists(abs)) return abs;
  }
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(baseDir, '..', '..', 'lcod-spec'),
    path.resolve(baseDir, '..', '..', '..', 'lcod-spec')
  ];
  for (const candidate of candidates) {
    if (await dirExists(candidate)) return candidate;
  }
  return null;
}

async function dirExists(candidate) {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function loadCompose(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const parsed = YAML.parse(text);
  if (!parsed || !Array.isArray(parsed.compose)) {
    throw new Error(`Invalid compose file: ${filePath}`);
  }
  return parsed.compose;
}

test('tooling/resolver compose runs with node core axioms', async (t) => {
  const specRoot = await resolveSpecRoot();
  if (!specRoot) {
    t.skip('lcod-spec repository not available (set SPEC_REPO_PATH to override)');
    return;
  }
  const composePath = path.join(specRoot, 'examples', 'tooling', 'resolver', 'compose.yaml');
  const compose = await loadCompose(composePath);
  const registry = new Registry();
  registerNodeCore(registry);
  registerNodeResolverAxioms(registry);
  registry.register('lcod://flow/if@1', flowIf);
  registry.register('lcod://flow/foreach@1', flowForeach);
  registry.register('lcod://flow/parallel@1', flowParallel);
  registry.register('lcod://flow/try@1', flowTry);
  registry.register('lcod://flow/throw@1', flowThrow);
  if (flowBreak) registry.register('lcod://flow/break@1', flowBreak);
  if (flowContinue) registry.register('lcod://flow/continue@1', flowContinue);

  const ctx = new Context(registry);
  const projectPath = path.join(specRoot, 'examples', 'tooling', 'resolver');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-resolver-'));
  const outputPath = path.join(tempDir, 'lcp.lock');
  const state = {
    projectPath,
    configPath: null,
    outputPath
  };

  const result = await runCompose(ctx, compose, state);
  assert.equal(result.lockPath, outputPath);
  const lockContent = await fs.readFile(outputPath, 'utf8');
  assert.ok(lockContent.includes('schemaVersion'));

  await fs.rm(tempDir, { recursive: true, force: true });
});
