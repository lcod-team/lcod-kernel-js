import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { resolveResolverComposePath } from './helpers/resolver.js';

async function resolveSpecRoot() {
  if (process.env.SPEC_REPO_PATH) {
    const candidate = path.resolve(process.env.SPEC_REPO_PATH);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {}
  }
  const candidates = [
    path.resolve(__dirname, '..', '..', 'lcod-spec'),
    path.resolve(__dirname, '..', '..', '..', 'lcod-spec')
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {}
  }
  return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('run-compose resolver CLI wires project/output/cache flags', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const composePath = await resolveResolverComposePath({ required: false });
  if (!composePath) {
    t.skip('resolver compose.yaml unavailable');
    return;
  }
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'lcod-cli-'));
  try {
    const projectToml = [
      'schemaVersion = "1.0"',
      'id = "lcod://example/app@0.1.0"',
      'name = "app"',
      'namespace = "example"',
      'version = "0.1.0"',
      'kind = "workflow"',
      '',
      '[deps]',
      'requires = []'
    ].join('\n');
    await fs.writeFile(path.join(tempProject, 'lcp.toml'), projectToml, 'utf8');

    const outputLock = path.join(tempProject, 'custom.lock');
    const cacheDir = path.join(tempProject, 'cache-dir');

    const specRoot = await resolveSpecRoot();
    const env = { ...process.env };
    if (specRoot) {
      env.SPEC_REPO_PATH = specRoot;
    }
    if (composePath) {
      const resolverRoot = path.resolve(composePath, '..', '..', '..');
      env.LCOD_RESOLVER_PATH = resolverRoot;
      env.LCOD_RESOLVER_COMPONENTS_PATH = path.join(resolverRoot, 'packages', 'resolver', 'components');
    }

    const { stdout } = await execFileAsync('node', [
      'bin/run-compose.mjs',
      '--compose',
      composePath,
      '--resolver',
      '--project',
      tempProject,
      '--output',
      outputLock,
      '--cache-dir',
      cacheDir
    ], { cwd: repoRoot, env });

    const result = JSON.parse(stdout);
    assert.equal(result.lockPath, outputLock);
    assert.ok(Array.isArray(result.components));
    if (!Array.isArray(result.components) || result.components.length === 0) {
      console.error('run-compose resolver result (debug):', JSON.stringify(result, null, 2));
    }
    const lockText = await fs.readFile(outputLock, 'utf8');
    assert.ok(lockText.includes('schemaVersion'));
    const defaultCache = path.join(tempProject, '.lcod', 'cache');
    const cacheCandidates = [cacheDir, defaultCache];
    const found = [];
    for (const candidate of cacheCandidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          found.push(candidate);
        }
      } catch {}
    }
    if (found.length === 0) {
      console.error('cache directories missing; candidates:', cacheCandidates);
      try {
        const listing = await Promise.all(cacheCandidates.map(async (candidate) => {
          const parent = path.dirname(candidate);
          const entries = await fs.readdir(parent).catch(() => []);
          return { candidate, entries };
        }));
        console.error('parent listings:', JSON.stringify(listing, null, 2));
      } catch (err) {
        console.error('failed to inspect cache directories', err);
      }
    }
    assert.ok(found.length > 0, 'expected at least one cache directory to exist');
  } finally {
    await fs.rm(tempProject, { recursive: true, force: true });
  }
});
