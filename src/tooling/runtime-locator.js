import fs from 'node:fs';
import path from 'node:path';

import { logKernelWarn } from './logging.js';

let cachedState = 'unknown';
let cachedRoot = null;
let cachedManifest = null;

export function getRuntimeRoot() {
  if (cachedState !== 'unknown') {
    return cachedRoot;
  }
  const home = process.env.LCOD_HOME;
  if (!home) {
    cachedState = 'absent';
    cachedRoot = null;
    return null;
  }

  const candidate = path.resolve(home);
  const manifestPath = path.join(candidate, 'manifest.json');
  const toolingPath = path.join(candidate, 'tooling');

  try {
    if (fs.existsSync(manifestPath) && fs.existsSync(toolingPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      cachedManifest = JSON.parse(raw);
      cachedManifest.__path = manifestPath;
      cachedRoot = candidate;
      cachedState = 'present';
      return candidate;
    }
  } catch (err) {
    logKernelWarn(null, 'Failed to read runtime manifest', {
      data: { manifestPath, error: err?.message },
      tags: { module: 'runtime-locator' }
    });
  }

  cachedState = 'absent';
  cachedRoot = null;
  cachedManifest = null;
  return null;
}

export function getRuntimeManifest() {
  if (cachedState === 'unknown') {
    getRuntimeRoot();
  }
  return cachedManifest;
}

export function getRuntimeResolverRoot() {
  const root = getRuntimeRoot();
  if (!root) {
    return null;
  }
  const candidate = path.join(root, 'resolver');
  const workspacePath = path.join(candidate, 'workspace.lcp.toml');
  if (fs.existsSync(candidate) && fs.existsSync(workspacePath)) {
    return candidate;
  }
  return null;
}
