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
import TOML from '@iarna/toml';
import { resolveResolverComposePath } from './helpers/resolver.js';

import { Registry, Context } from '../src/registry.js';
import { runCompose } from '../src/compose.js';
import { registerNodeCore, registerNodeResolverAxioms } from '../src/core/index.js';
import { registerTooling } from '../src/tooling/index.js';
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
  const context = await loadManifestContext(filePath);
  if (context) {
    canonicalizeCompose(parsed.compose, context);
  }
  return parsed.compose;
}

async function loadManifestContext(composePath) {
  const dir = path.dirname(composePath);
  const manifestPath = path.join(dir, 'lcp.toml');
  try {
    const manifestText = await fs.readFile(manifestPath, 'utf8');
    const manifest = TOML.parse(manifestText);
    const id = typeof manifest.id === 'string' ? manifest.id : null;
    const basePath = id && id.startsWith('lcod://')
      ? id.slice('lcod://'.length).split('@')[0]
      : [manifest.namespace, manifest.name]
          .filter((part) => typeof part === 'string' && part.length > 0)
          .join('/');
    const version = typeof manifest.version === 'string'
      ? manifest.version
      : (id && id.includes('@') ? id.split('@')[1] : '0.0.0');
    if (!basePath) return null;
    const aliasMap = manifest.workspace?.scopeAliases && typeof manifest.workspace.scopeAliases === 'object'
      ? manifest.workspace.scopeAliases
      : {};
    return { basePath, version, aliasMap };
  } catch {
    return null;
  }
}

function canonicalizeCompose(steps, context) {
  if (!Array.isArray(steps)) return;
  for (const step of steps) {
    canonicalizeStep(step, context);
  }
}

function canonicalizeStep(step, context) {
  if (!step || typeof step !== 'object') return;
  if (typeof step.call === 'string') {
    step.call = canonicalizeId(step.call, context);
  }
  const slotCollections = [];
  if (step.slots && typeof step.slots === 'object') {
    slotCollections.push(step.slots);
  }
  if (step.children && typeof step.children === 'object') {
    slotCollections.push(step.children);
  }
  for (const collection of slotCollections) {
    if (Array.isArray(collection)) {
      for (const child of collection) canonicalizeStep(child, context);
      continue;
    }
    for (const key of Object.keys(collection)) {
      const branch = collection[key];
      if (Array.isArray(branch)) {
        for (const child of branch) canonicalizeStep(child, context);
      } else if (branch && typeof branch === 'object') {
        canonicalizeValue(branch, context);
      }
    }
  }
  if (step.in) canonicalizeValue(step.in, context);
  if (step.out) canonicalizeValue(step.out, context);
  if (step.bindings) canonicalizeValue(step.bindings, context);
}

function canonicalizeValue(value, context) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) canonicalizeValue(item, context);
    return;
  }
  if (typeof value !== 'object') return;
  if (typeof value.call === 'string') {
    canonicalizeStep(value, context);
    return;
  }
  for (const key of Object.keys(value)) {
    canonicalizeValue(value[key], context);
  }
}

function canonicalizeId(raw, context) {
  if (typeof raw !== 'string' || raw.startsWith('lcod://')) return raw;
  const segments = raw.replace(/^\.\//, '').split('/').filter(Boolean);
  if (segments.length === 0) return raw;
  const alias = segments[0];
  const mapped = context.aliasMap?.[alias] ?? alias;
  const remainder = segments.slice(1);
  const parts = [];
  if (context.basePath) parts.push(context.basePath);
  if (mapped) parts.push(mapped);
  if (remainder.length) parts.push(...remainder);
  if (!parts.length) return raw;
  const version = context.version || '0.0.0';
  return `lcod://${parts.join('/')}` + `@${version}`;
}

async function createRegistry() {
  const registry = new Registry();
  registerNodeCore(registry);
  registerNodeResolverAxioms(registry);
  registerTooling(registry);
  registry.register('lcod://flow/if@1', flowIf);
  registry.register('lcod://flow/foreach@1', flowForeach);
  registry.register('lcod://flow/parallel@1', flowParallel);
  registry.register('lcod://flow/try@1', flowTry);
  registry.register('lcod://flow/throw@1', flowThrow);
  if (flowBreak) registry.register('lcod://flow/break@1', flowBreak);
  if (flowContinue) registry.register('lcod://flow/continue@1', flowContinue);
  const ready = registry.__toolingReady;
  if (ready && typeof ready.then === 'function') {
    await ready;
  }
  if (!registry.get('lcod://tooling/fs/read_optional@0.1.0')) {
    throw new Error('tooling/fs/read_optional@0.1.0 not registered after bootstrap');
  }
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
  const registry = await createRegistry();
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

test('resolver compose resolves local path dependency', async (t) => {
  const registry = await createRegistry();
  const ctx = new Context(registry);
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-resolver-path-'));
  try {
    const specRoot = await resolveSpecRoot();
    if (!specRoot) {
      t.skip('lcod-spec repository not available (set SPEC_REPO_PATH to override)');
      return;
    }
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
        tooling: {
          specRoot
        },
        registry: {
          sources: []
        },
        sources: {
          'lcod://example/dep@0.1.0': { type: 'path', path: 'components/dep' }
        }
      }, null, 2),
      'utf8'
    );

    const composePath = await resolveResolverComposePath({ required: false });
    if (!composePath) {
      t.skip('resolver compose.yaml unavailable');
      return;
    }
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
    assert.equal(depEntry.source?.type, 'registry');
    assert.equal(depEntry.source?.reference, 'lcod://example/dep@0.1.0');
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const allowedWarning = 'Registry lookup failed for lcod://example/dep@0.1.0';
    const unexpectedWarnings = warnings.filter((warning) => warning !== allowedWarning);
    assert.equal(
      unexpectedWarnings.length,
      0,
      `Unexpected warnings: ${unexpectedWarnings.join(', ')}`
    );
  } finally {
    await fs.rm(tempProject, { recursive: true, force: true });
  }
});

test('resolver compose handles git sources with cache dir', async (t) => {
  const registry = await createRegistry();
  const ctx = new Context(registry);
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-resolver-git-'));
  const repoDir = path.join(tempProject, 'repo');
  const cacheOverride = path.join(tempProject, 'cache');
  process.env.LCOD_CACHE_DIR = cacheOverride;

  try {
    const specRoot = await resolveSpecRoot();
    if (!specRoot) {
      t.skip('lcod-spec repository not available (set SPEC_REPO_PATH to override)');
      return;
    }
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
        tooling: {
          specRoot
        },
        registry: {
          sources: []
        },
        sources: {
          'lcod://example/git@0.1.0': { type: 'git', url: repoDir }
        }
      }, null, 2),
      'utf8'
    );

    const composePath = await resolveResolverComposePath({ required: false });
    if (!composePath) {
      t.skip('resolver compose.yaml unavailable');
      return;
    }
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
    assert.equal(depEntry.source?.type, 'registry');
    assert.equal(depEntry.source?.reference, 'lcod://example/git@0.1.0');
    assert.ok(rootEntry.integrity);
  } finally {
    delete process.env.LCOD_CACHE_DIR;
    await fs.rm(tempProject, { recursive: true, force: true });
  }
});
