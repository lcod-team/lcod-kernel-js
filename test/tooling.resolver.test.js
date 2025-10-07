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
import { flowIf } from '../src/flow/if.js';
import { flowForeach } from '../src/flow/foreach.js';
import { flowParallel } from '../src/flow/parallel.js';
import { flowTry } from '../src/flow/try.js';
import { flowThrow } from '../src/flow/throw.js';
import { flowBreak } from '../src/flow/break.js';
import { flowContinue } from '../src/flow/continue.js';

const execFileAsync = promisify(execFile);

function integrityOf(text) {
  return `sha256-${crypto.createHash('sha256').update(text).digest('base64')}`;
}

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
  assert.ok(Array.isArray(result.components));
  const warnings = result.warnings || [];
  assert.ok(Array.isArray(warnings));
  const lockContent = await fs.readFile(outputPath, 'utf8');
  assert.ok(lockContent.includes('schemaVersion'));

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('resolve-dependency computes integrity for path sources', async () => {
  const registry = new Registry();
  registerNodeCore(registry);
  registerNodeResolverAxioms(registry);
  const ctx = new Context(registry);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-resolver-path-'));
  try {
    const componentDir = path.join(tempDir, 'comp');
    await fs.mkdir(componentDir, { recursive: true });
    const descriptorText = [
      'schemaVersion = "1.0"',
      'id = "lcod://example/comp@0.1.0"',
      'name = "comp"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = []'
    ].join('\n');
    await fs.writeFile(path.join(componentDir, 'lcp.toml'), descriptorText, 'utf8');

    const { resolved, warnings } = await ctx.call('lcod://contract/tooling/resolve-dependency@1', {
      dependency: 'lcod://example/comp@0.1.0',
      config: {
        sources: {
          'lcod://example/comp@0.1.0': { type: 'path', path: 'comp' }
        }
      },
      projectPath: tempDir,
      stack: []
    });

    assert.equal(resolved.source.type, 'path');
    assert.equal(resolved.source.path, path.join(tempDir, 'comp'));
    assert.equal(resolved.integrity, integrityOf(descriptorText));
    assert.deepEqual(resolved.dependencies, []);
    assert.deepEqual(warnings, []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolve-dependency clones git sources and caches integrity', async () => {
  const registry = new Registry();
  registerNodeCore(registry);
  registerNodeResolverAxioms(registry);
  const ctx = new Context(registry);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-resolver-git-'));
  const repoDir = path.join(tempDir, 'repo');
  const cacheDir = path.join(tempDir, 'cache');
  process.env.LCOD_CACHE_DIR = cacheDir;

  try {
    await fs.mkdir(repoDir, { recursive: true });
    const descriptorText = [
      'schemaVersion = "1.0"',
      'id = "lcod://example/git@0.1.0"',
      'name = "git-dep"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = []'
    ].join('\n');
    await fs.writeFile(path.join(repoDir, 'lcp.toml'), descriptorText, 'utf8');
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'resolver@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Resolver Bot'], { cwd: repoDir });
    await execFileAsync('git', ['add', 'lcp.toml'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_NAME: 'Resolver Bot', GIT_AUTHOR_EMAIL: 'resolver@example.com', GIT_COMMITTER_NAME: 'Resolver Bot', GIT_COMMITTER_EMAIL: 'resolver@example.com' } });

    const { resolved, warnings } = await ctx.call('lcod://contract/tooling/resolve-dependency@1', {
      dependency: 'lcod://example/git@0.1.0',
      config: {
        sources: {
          'lcod://example/git@0.1.0': { type: 'git', url: repoDir }
        }
      },
      projectPath: tempDir,
      stack: []
    });

    assert.equal(resolved.source.type, 'git');
    const projectCache = path.join(tempDir, '.lcod', 'cache');
    assert.ok(resolved.source.path.startsWith(projectCache));
    assert.match(resolved.integrity, /^sha256-/);
    assert.deepEqual(resolved.dependencies, []);
    assert.deepEqual(warnings, []);
  } finally {
    delete process.env.LCOD_CACHE_DIR;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolve-dependency detects cycles', async () => {
  const registry = new Registry();
  registerNodeCore(registry);
  registerNodeResolverAxioms(registry);
  const ctx = new Context(registry);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-resolver-cycle-'));
  const compA = path.join(tempDir, 'compA');
  const compB = path.join(tempDir, 'compB');
  await fs.mkdir(compA, { recursive: true });
  await fs.mkdir(compB, { recursive: true });
  await fs.writeFile(
    path.join(compA, 'lcp.toml'),
    [
      'schemaVersion = "1.0"',
      'id = "lcod://example/a@0.1.0"',
      'name = "a"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = ["lcod://example/b@0.1.0"]'
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(
    path.join(compB, 'lcp.toml'),
    [
      'schemaVersion = "1.0"',
      'id = "lcod://example/b@0.1.0"',
      'name = "b"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = ["lcod://example/a@0.1.0"]'
    ].join('\n'),
    'utf8'
  );

  const config = {
    sources: {
      'lcod://example/a@0.1.0': { type: 'path', path: 'compA' },
      'lcod://example/b@0.1.0': { type: 'path', path: 'compB' }
    }
  };

  await assert.rejects(
    ctx.call('lcod://contract/tooling/resolve-dependency@1', {
      dependency: 'lcod://example/a@0.1.0',
      config,
      projectPath: tempDir,
      stack: []
    }),
    /Dependency cycle detected/
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});
