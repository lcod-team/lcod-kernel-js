import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { runSteps } from '../compose/runtime.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');

const componentDefs = buildComponentDefinitions();
const composeCache = new Map();

function resolveSpecRoot() {
  const envPath = process.env.SPEC_REPO_PATH;
  const candidates = [];
  if (envPath) candidates.push(path.resolve(envPath));
  candidates.push(path.resolve(repoRoot, '..', 'lcod-spec'));
  candidates.push(path.resolve(process.cwd(), '../lcod-spec'));
  candidates.push(path.resolve(process.cwd(), '../../lcod-spec'));
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch (_) {
      // ignore missing candidate
    }
  }
  return null;
}

function buildComponentDefinitions() {
  const specRoot = resolveSpecRoot();
  if (!specRoot) {
    console.warn('[tooling/registry] Unable to locate lcod-spec repository; registry tooling components will not be available.');
    return [];
  }
  const descriptors = [
    {
      id: 'lcod://tooling/registry/index@0.1.0',
      compose: path.join(specRoot, 'tooling/registry/index/compose.yaml')
    },
    {
      id: 'lcod://tooling/registry/fetch@0.1.0',
      compose: path.join(specRoot, 'tooling/registry/fetch/compose.yaml')
    },
    {
      id: 'lcod://tooling/registry/source/load@0.1.0',
      compose: path.join(specRoot, 'tooling/registry/source/compose.yaml')
    },
    {
      id: 'lcod://tooling/registry/select@0.1.0',
      compose: path.join(specRoot, 'tooling/registry/select/compose.yaml')
    },
    {
      id: 'lcod://tooling/registry/resolution@0.1.0',
      compose: path.join(specRoot, 'tooling/registry/resolution/compose.yaml')
    }
  ];
  const defs = [];
  for (const descriptor of descriptors) {
    if (!fs.existsSync(descriptor.compose)) {
      console.warn(`[tooling/registry] Compose file missing for ${descriptor.id}: ${descriptor.compose}`);
      continue;
    }
    defs.push(descriptor);
  }
  return defs;
}

function loadCompose(def) {
  if (composeCache.has(def.compose)) {
    return composeCache.get(def.compose);
  }
  const raw = fs.readFileSync(def.compose, 'utf8');
  const doc = YAML.parse(raw);
  if (!doc || !Array.isArray(doc.compose)) {
    throw new Error(`Invalid compose file for ${def.id}: ${def.compose}`);
  }
  const entry = { steps: doc.compose, path: def.compose };
  composeCache.set(def.compose, entry);
  return entry;
}

export function registerRegistryComponents(registry) {
  for (const def of componentDefs) {
    registry.register(def.id, async (ctx, input = {}) => {
      const { steps } = loadCompose(def);
      const result = await runSteps(ctx, steps, input);
      return result;
    });
  }
  return registry;
}
