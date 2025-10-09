import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { runSteps } from '../compose/runtime.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');

const helperDefs = [
  {
    id: 'lcod://resolver/internal/load-descriptor@1',
    segments: ['components', 'internal', 'load_descriptor', 'compose.yaml']
  },
  {
    id: 'lcod://resolver/internal/load-config@1',
    segments: ['components', 'internal', 'load_config', 'compose.yaml']
  },
  {
    id: 'lcod://resolver/internal/lock-path@1',
    segments: ['components', 'internal', 'lock_path', 'compose.yaml']
  },
  {
    id: 'lcod://resolver/internal/build-lock@1',
    segments: ['components', 'internal', 'build_lock', 'compose.yaml']
  }
];

const cache = new Map();

async function loadHelper(def) {
  const key = def.segments.join('/');
  if (cache.has(key)) return cache.get(key);

  const candidates = [];
  if (process.env.LCOD_RESOLVER_COMPONENTS_PATH) {
    candidates.push(path.resolve(process.env.LCOD_RESOLVER_COMPONENTS_PATH, ...def.segments));
  }
  if (process.env.LCOD_RESOLVER_PATH) {
    candidates.push(path.resolve(process.env.LCOD_RESOLVER_PATH, ...def.segments));
  }
  candidates.push(path.resolve(repoRoot, '..', 'lcod-resolver', ...def.segments));
  // Legacy fallback while specs transition away from embedded helpers
  candidates.push(
    path.resolve(repoRoot, '..', 'lcod-spec', 'tooling', 'resolver', def.segments[2], 'compose.yaml')
  );

  let lastError;
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const doc = YAML.parse(raw);
      if (!doc || !Array.isArray(doc.compose)) {
        throw new Error(`Invalid compose file: ${candidate}`);
      }
      const entry = { steps: doc.compose, path: candidate };
      cache.set(key, entry);
      return entry;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        lastError = err;
        continue;
      }
      throw new Error(
        `Failed to load resolver helper "${def.id}" from ${candidate}: ${err.message || err}`
      );
    }
  }
  const searched = candidates.join(', ');
  throw new Error(
    `Unable to locate resolver helper "${def.id}". Searched: ${searched}${
      lastError ? ` (last error: ${lastError.message || lastError})` : ''
    }`
  );
}

export function registerResolverHelpers(registry) {
  for (const def of helperDefs) {
    registry.register(def.id, async (ctx, input = {}) => {
      const { steps } = await loadHelper(def);
      const resultState = await runSteps(ctx, steps, input);
      return resultState;
    });
  }
  return registry;
}
