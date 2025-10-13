import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { runSteps } from '../compose/runtime.js';
import { Context } from '../registry.js';
import { getRuntimeRoot } from './runtime-locator.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');
const composeCache = new Map();

function resolveSpecRoot() {
  const hasRegisterCompose = (root) => {
    const registerCompose = path.join(root, 'tooling/resolver/register_components/compose.yaml');
    try {
      return fs.statSync(registerCompose).isFile();
    } catch (_) {
      return false;
    }
  };

  const candidates = [];
  const runtimeRoot = getRuntimeRoot();
  if (runtimeRoot) candidates.push(runtimeRoot);
  if (process.env.SPEC_REPO_PATH) candidates.push(path.resolve(process.env.SPEC_REPO_PATH));
  candidates.push(path.resolve(repoRoot, '..', 'lcod-spec'));
  candidates.push(path.resolve(process.cwd(), '../lcod-spec'));
  candidates.push(path.resolve(process.cwd(), '../../lcod-spec'));

  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
      if (hasRegisterCompose(candidate)) {
        return candidate;
      }
    } catch (_) {
      // ignore missing candidate
    }
  }
  return null;
}

function loadComposeFromPath(composePath) {
  if (composeCache.has(composePath)) {
    return composeCache.get(composePath);
  }
  const raw = fs.readFileSync(composePath, 'utf8');
  const doc = YAML.parse(raw);
  if (!doc || !Array.isArray(doc.compose)) {
    throw new Error(`Invalid compose file: ${composePath}`);
  }
  composeCache.set(composePath, doc.compose);
  return doc.compose;
}

export async function registerRegistryComponents(registry) {
  const specRoot = resolveSpecRoot();
  if (!specRoot) {
    console.warn('[tooling/registry] Unable to locate LCOD runtime or lcod-spec checkout; registry helpers will not be available.');
    return registry;
  }
  const registerPath = path.join(
    specRoot,
    'tooling/resolver/register_components/compose.yaml'
  );
  if (!fs.existsSync(registerPath)) {
    console.warn(
      `[tooling/registry] register_components compose not found: ${registerPath}`
    );
    return registry;
  }
  const steps = loadComposeFromPath(registerPath);
  const ctx = new Context(registry);
  let resultState;
  try {
    resultState = await runSteps(ctx, steps, { specRoot });
  } catch (err) {
    console.warn(
      `[tooling/registry] Failed to execute register_components compose: ${err.message || err}`
    );
  }
  if (resultState && Array.isArray(resultState.warnings) && resultState.warnings.length > 0) {
    for (const warning of resultState.warnings) {
      console.warn(`[tooling/registry] ${warning}`);
    }
  }

  if (!registry.get('lcod://axiom/path/join@1')) {
    console.warn('[tooling/registry] Skipping registry helper bootstrap: lcod://axiom/path/join@1 not registered.');
    return registry;
  }

  registry.register(
    'lcod://tooling/resolver/register_components@0.1.0',
    async (ctx, input = {}) => {
      const override = typeof input.specRoot === 'string' && input.specRoot.length > 0
        ? input.specRoot
        : specRoot;
      const bootstrapSteps = loadComposeFromPath(registerPath);
      return runSteps(ctx, bootstrapSteps, { specRoot: override });
    }
  );
  return registry;
}
