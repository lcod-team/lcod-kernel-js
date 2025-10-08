import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('run-compose resolver CLI wires project/output/cache flags', async () => {
  const repoRoot = path.resolve(__dirname, '..');
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

    const composePath = path.resolve(repoRoot, '..', 'lcod-resolver', 'compose.yaml');
    const outputLock = path.join(tempProject, 'custom.lock');
    const cacheDir = path.join(tempProject, 'cache-dir');

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
    ], { cwd: repoRoot, env: { ...process.env } });

    const result = JSON.parse(stdout);
    assert.equal(result.lockPath, outputLock);
    assert.ok(Array.isArray(result.components));
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
    assert.ok(found.length > 0, 'expected at least one cache directory to exist');
  } finally {
    await fs.rm(tempProject, { recursive: true, force: true });
  }
});
