import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { Registry, Context } from '../src/registry.js';
import { runCompose } from '../src/compose.js';
import { registerNodeCore, registerNodeResolverAxioms } from '../src/core/index.js';
import { registerScriptContract } from '../src/tooling/script.js';
import { flowIf } from '../src/flow/if.js';
import { flowForeach } from '../src/flow/foreach.js';
import { flowParallel } from '../src/flow/parallel.js';
import { flowTry } from '../src/flow/try.js';
import { flowThrow } from '../src/flow/throw.js';
import { flowBreak } from '../src/flow/break.js';
import { flowContinue } from '../src/flow/continue.js';

const execFileAsync = promisify(execFile);

function integrityOf(text) {
  return `sha256-${crypto.createHash('sha256').update(text).digest('hex')}`;
}

async function resolveSpecRoot() {
  const override = process.env.SPEC_REPO_PATH;
  if (override) {
    const abs = path.resolve(override);
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) return abs;
    } catch {}
  }
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(baseDir, '..', '..', 'lcod-spec'),
    path.resolve(baseDir, '..', '..', '..', 'lcod-spec')
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {}
  }
  return null;
}

async function loadCompose(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const parsed = YAML.parse(text);
  if (!parsed || !Array.isArray(parsed.compose)) {
    throw new Error(`Invalid compose file: ${filePath}`);
  }
  return parsed.compose;
}

function createRegistry() {
  const registry = new Registry();
  registerNodeCore(registry);
  registerScriptContract(registry);
  registerNodeResolverAxioms(registry);
  registry.register('lcod://flow/if@1', flowIf);
  registry.register('lcod://flow/foreach@1', flowForeach);
  registry.register('lcod://flow/parallel@1', flowParallel);
  registry.register('lcod://flow/try@1', flowTry);
  registry.register('lcod://flow/throw@1', flowThrow);
  if (flowBreak) registry.register('lcod://flow/break@1', flowBreak);
  if (flowContinue) registry.register('lcod://flow/continue@1', flowContinue);
  return registry;
}

test('resolver example compose produces lockfile', async (t) => {
  const specRoot = await resolveSpecRoot();
  if (!specRoot) {
    t.skip('lcod-spec repository not available (set SPEC_REPO_PATH to override)');
    return;
  }
  const composePath = path.join(specRoot, 'examples', 'tooling', 'resolver', 'compose.yaml');
  const compose = await loadCompose(composePath);
  const registry = createRegistry();
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
  assert.ok(Array.isArray(result.components));
  const lockContent = await fs.readFile(outputPath, 'utf8');
  assert.ok(lockContent.includes('schemaVersion'));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('resolver compose resolves local path dependency', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-resolver-path-'));
  try {
    const depDir = path.join(tempProject, 'components', 'dep');
    await fs.mkdir(depDir, { recursive: true });
    const depDescriptor = [
      'schemaVersion = "1.0"',
      'id = "lcod://example/dep@0.1.0"',
      'name = "dep"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = []'
    ].join('\n');
    await fs.writeFile(path.join(depDir, 'lcp.toml'), depDescriptor, 'utf8');

    const rootDescriptor = [
      'schemaVersion = "1.0"',
      'id = "lcod://example/app@0.1.0"',
      'name = "app"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = ["lcod://example/dep@0.1.0"]'
    ].join('\n');
    await fs.writeFile(path.join(tempProject, 'lcp.toml'), rootDescriptor, 'utf8');

    const configPath = path.join(tempProject, 'resolve.config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        sources: {
          'lcod://example/dep@0.1.0': { type: 'path', path: 'components/dep' }
        }
      }, null, 2),
      'utf8'
    );

    const composePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lcod-resolver', 'compose.yaml');
    const compose = await loadCompose(composePath);
    const outputPath = path.join(tempProject, 'lcp.lock');
    const state = {
      projectPath: tempProject,
      configPath,
      outputPath
    };

    const result = await runCompose(ctx, compose, state);
    const components = Array.isArray(result.components) ? result.components : [];
    assert.equal(components.length, 1);
    const rootEntry = components[0];
    assert.equal(rootEntry.id, 'lcod://example/app@0.1.0');
    assert.equal(rootEntry.source?.type, 'path');
    assert.equal(rootEntry.integrity, integrityOf(rootDescriptor));
    const deps = Array.isArray(rootEntry.dependencies) ? rootEntry.dependencies : [];
    assert.equal(deps.length, 1);
    const depEntry = deps[0];
    assert.equal(depEntry.id, 'lcod://example/dep@0.1.0');
    assert.equal(depEntry.source?.type, 'path');
    assert.deepEqual(result.warnings || [], []);
  } finally {
    await fs.rm(tempProject, { recursive: true, force: true });
  }
});

test('resolver compose handles git sources with cache dir', async () => {
  const registry = createRegistry();
  const ctx = new Context(registry);
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-resolver-git-'));
  const repoDir = path.join(tempProject, 'repo');
  const cacheOverride = path.join(tempProject, 'cache');
  process.env.LCOD_CACHE_DIR = cacheOverride;

  try {
    await fs.mkdir(repoDir, { recursive: true });
    const depDescriptor = [
      'schemaVersion = "1.0"',
      'id = "lcod://example/git@0.1.0"',
      'name = "git"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = []'
    ].join('\n');
    await fs.writeFile(path.join(repoDir, 'lcp.toml'), depDescriptor, 'utf8');
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'resolver@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Resolver Bot'], { cwd: repoDir });
    await execFileAsync('git', ['add', 'lcp.toml'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_NAME: 'Resolver Bot', GIT_AUTHOR_EMAIL: 'resolver@example.com', GIT_COMMITTER_NAME: 'Resolver Bot', GIT_COMMITTER_EMAIL: 'resolver@example.com' } });

    const projectDescriptor = [
      'schemaVersion = "1.0"',
      'id = "lcod://example/app@0.1.0"',
      'name = "app"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = ["lcod://example/git@0.1.0"]'
    ].join('\n');
    await fs.writeFile(path.join(tempProject, 'lcp.toml'), projectDescriptor, 'utf8');

    const configPath = path.join(tempProject, 'resolve.config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        sources: {
          'lcod://example/git@0.1.0': { type: 'git', url: repoDir }
        }
      }, null, 2),
      'utf8'
    );

    const composePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lcod-resolver', 'compose.yaml');
    const compose = await loadCompose(composePath);
    const outputPath = path.join(tempProject, 'lcp.lock');
    const state = {
      projectPath: tempProject,
      configPath,
      outputPath
    };

    const result = await runCompose(ctx, compose, state);
    const components = Array.isArray(result.components) ? result.components : [];
    assert.equal(components.length, 1);
    const rootEntry = components[0];
    assert.equal(rootEntry.id, 'lcod://example/app@0.1.0');
    assert.equal(rootEntry.source?.type, 'path');
    const deps = Array.isArray(rootEntry.dependencies) ? rootEntry.dependencies : [];
    assert.equal(deps.length, 1);
    const depEntry = deps[0];
    assert.equal(depEntry.id, 'lcod://example/git@0.1.0');
    assert.equal(depEntry.source?.type, 'git');
    const localCache = path.join(tempProject, '.lcod', 'cache');
    const sourcePath = String(depEntry.source?.path || '');
    assert.ok(
      sourcePath.startsWith(localCache) || sourcePath.startsWith(cacheOverride),
      `expected ${sourcePath} to start with ${localCache} or ${cacheOverride}`
    );
    assert.ok(rootEntry.integrity);
  } finally {
    delete process.env.LCOD_CACHE_DIR;
    await fs.rm(tempProject, { recursive: true, force: true });
  }
});
