import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { Registry, Context } from '../src/registry.js';
import { registerNodeCore, registerNodeResolverAxioms } from '../src/core/index.js';
import { registerFlowPrimitives } from '../src/flow/register.js';
import { registerTooling } from '../src/tooling/index.js';
import { refreshResolverHelperCache } from '../src/tooling/resolver-helpers.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..');

test('LCOD runtime bundle supports catalog generation', async (t) => {
  const specRoot = await locateRepo(process.env.SPEC_REPO_PATH, '../lcod-spec').catch(() => null);
  if (!specRoot) {
    t.skip('lcod-spec repository not available');
    return;
  }
  const resolverRoot = await locateRepo(
    process.env.LCOD_RESOLVER_PATH,
    '../lcod-resolver'
  ).catch(() => null);
  if (!resolverRoot) {
    t.skip('lcod-resolver repository not available');
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-runtime-js-'));
  const runtimeRoot = path.join(tempRoot, 'lcod-runtime-test');
  await fs.mkdir(runtimeRoot, { recursive: true });

  await copyDir(path.join(specRoot, 'tooling'), path.join(runtimeRoot, 'tooling'));
  await copyDir(
    path.join(specRoot, 'tests', 'spec'),
    path.join(runtimeRoot, 'tests', 'spec')
  );
  await copyDir(
    path.join(specRoot, 'tests', 'conformance'),
    path.join(runtimeRoot, 'tests', 'conformance')
  );
  await copyDir(path.join(specRoot, 'schemas'), path.join(runtimeRoot, 'schemas'));

  await fs.mkdir(path.join(runtimeRoot, 'resolver'), { recursive: true });
  await fs.copyFile(
    path.join(resolverRoot, 'workspace.lcp.toml'),
    path.join(runtimeRoot, 'resolver', 'workspace.lcp.toml')
  );
  await copyDir(
    path.join(resolverRoot, 'packages', 'resolver'),
    path.join(runtimeRoot, 'resolver', 'packages', 'resolver')
  );

  await fs.mkdir(path.join(runtimeRoot, 'metadata'), { recursive: true });
  const snapshotPath = path.join(
    resolverRoot,
    'runtime',
    'lcod-resolver-runtime.json'
  );
  if (!fssync.existsSync(snapshotPath)) {
    throw new Error(
      `Resolver runtime snapshot missing at ${snapshotPath}. Run node scripts/export-runtime.mjs in lcod-resolver.`
    );
  }
  await fs.copyFile(
    snapshotPath,
    path.join(runtimeRoot, 'metadata', 'lcod-resolver-runtime.json')
  );

  const pkg = JSON.parse(
    await fs.readFile(path.join(specRoot, 'package.json'), 'utf8')
  );
  const resolverSnapshot = JSON.parse(
    await fs.readFile(
      path.join(runtimeRoot, 'metadata', 'lcod-resolver-runtime.json'),
      'utf8'
    )
  );
  const manifest = {
    schemaVersion: '1.0',
    label: 'test',
    generatedAt: new Date().toISOString(),
    spec: {
      version: pkg.version ?? '0.0.0',
      commit: 'test-local',
    },
    resolver: {
      commit: resolverSnapshot.commit ?? 'unknown',
      snapshot: 'metadata/lcod-resolver-runtime.json',
    },
    contents: [
      { path: 'tooling', description: 'Spec helper components' },
      { path: 'tests/spec', description: 'Spec fixtures' },
      { path: 'tests/conformance', description: 'Conformance manifest' },
      { path: 'schemas', description: 'Shared schemas' },
      { path: 'resolver', description: 'Resolver workspace snapshot' },
      {
        path: 'metadata/lcod-resolver-runtime.json',
        description: 'Resolver metadata',
      },
    ],
  };
  await fs.writeFile(
    path.join(runtimeRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  const previousEnv = {
    LCOD_HOME: process.env.LCOD_HOME,
    SPEC_REPO_PATH: process.env.SPEC_REPO_PATH,
    LCOD_RESOLVER_PATH: process.env.LCOD_RESOLVER_PATH,
    LCOD_RESOLVER_COMPONENTS_PATH: process.env.LCOD_RESOLVER_COMPONENTS_PATH,
  };

  process.env.LCOD_HOME = runtimeRoot;
  process.env.SPEC_REPO_PATH = runtimeRoot;
  process.env.LCOD_RESOLVER_PATH = path.join(runtimeRoot, 'resolver');
  process.env.LCOD_RESOLVER_COMPONENTS_PATH = path.join(runtimeRoot, 'resolver', 'packages', 'resolver', 'components');
  refreshResolverHelperCache();

  try {
    const registry = new Registry();
    registerFlowPrimitives(registry);
    registerNodeCore(registry);
    registerTooling(registry);
    registerNodeResolverAxioms(registry);

    const ctx = new Context(registry);
    const fixturesRoot = path.join(
      specRoot,
      'tooling',
      'registry',
      'catalog',
      'test',
      'fixtures'
    );
    const result = await ctx.call(
      'lcod://tooling/registry/catalog/generate@0.1.0',
      {
        rootPath: fixturesRoot,
        catalogPath: 'catalog.json',
      }
    );

    assert.ok(
      typeof result.packagesJsonl === 'string' &&
        result.packagesJsonl.includes('lcod://demo/catalog'),
      'packagesJsonl should contain demo/catalog entries'
    );
    assert.ok(
      result.registryJson && result.registryJson.namespaces,
      'registryJson should include namespaces'
    );
  } finally {
    restoreEnv(previousEnv);
    refreshResolverHelperCache();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function locateRepo(envOverride, fallbackRelative) {
  if (envOverride) {
    const abs = path.resolve(envOverride);
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) return abs;
    } catch {}
  }
  const candidates = [
    path.resolve(repoRoot, fallbackRelative),
    path.resolve(process.cwd(), fallbackRelative),
    path.resolve(process.cwd(), '..', fallbackRelative),
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {}
  }
  throw new Error(`Unable to locate ${fallbackRelative}; set environment variable.`);
}

async function copyDir(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
}

function restoreEnv(previous) {
  if (previous.LCOD_HOME === undefined) {
    delete process.env.LCOD_HOME;
  } else {
    process.env.LCOD_HOME = previous.LCOD_HOME;
  }
  if (previous.SPEC_REPO_PATH === undefined) {
    delete process.env.SPEC_REPO_PATH;
  } else {
    process.env.SPEC_REPO_PATH = previous.SPEC_REPO_PATH;
  }
  if (previous.LCOD_RESOLVER_PATH === undefined) {
    delete process.env.LCOD_RESOLVER_PATH;
  } else {
    process.env.LCOD_RESOLVER_PATH = previous.LCOD_RESOLVER_PATH;
  }
  if (previous.LCOD_RESOLVER_COMPONENTS_PATH === undefined) {
    delete process.env.LCOD_RESOLVER_COMPONENTS_PATH;
  } else {
    process.env.LCOD_RESOLVER_COMPONENTS_PATH =
      previous.LCOD_RESOLVER_COMPONENTS_PATH;
  }
}
