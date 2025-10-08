import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Registry, Context } from '../registry.js';
import { runSteps } from './runtime.js';
import { registerTooling } from '../tooling/index.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');

let composePathPromise;

async function resolveComposePath() {
  if (!composePathPromise) {
    composePathPromise = (async () => {
      const candidates = [];
      if (process.env.LCOD_SPEC_PATH) {
        candidates.push(
          path.resolve(
            process.env.LCOD_SPEC_PATH,
            'tooling',
            'compose',
            'normalize',
            'compose.yaml'
          )
        );
      }
      candidates.push(
        path.resolve(
          repoRoot,
          '..',
          'lcod-spec',
          'tooling',
          'compose',
          'normalize',
          'compose.yaml'
        )
      );
      candidates.push(path.join(repoRoot, 'resources', 'compose', 'normalize', 'compose.yaml'));

      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          return candidate;
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            throw err;
          }
        }
      }

      throw new Error(
        `Unable to locate compose normalizer component. Searched: ${candidates.join(', ')}`
      );
    })();
  }
  return composePathPromise;
}

let cachedStepsPromise;
async function loadNormalizerSteps() {
  if (!cachedStepsPromise) {
    cachedStepsPromise = (async () => {
      const composePath = await resolveComposePath();
      let raw;
      try {
        raw = await fs.readFile(composePath, 'utf8');
      } catch (err) {
        throw new Error(
          `Unable to read compose normalizer component at ${composePath}: ${err.message || err}`
        );
      }
      const doc = YAML.parse(raw);
      if (!doc || !Array.isArray(doc.compose)) {
        throw new Error(`Invalid compose file for normalizer: ${composePath}`);
      }
      return doc.compose;
    })();
  }
  return cachedStepsPromise;
}

let sharedRegistry;
function getRegistry() {
  if (!sharedRegistry) {
    const reg = registerTooling(new Registry());
    reg.register('lcod://impl/set@1', async (_ctx, input = {}) => ({ ...input }));
    sharedRegistry = reg;
  }
  return sharedRegistry;
}

export async function normalizeCompose(compose) {
  if (!Array.isArray(compose)) return compose;
  const [steps, registry] = await Promise.all([loadNormalizerSteps(), getRegistry()]);
  const ctx = new Context(registry);
  const result = await runSteps(ctx, steps, { compose }, {});
  return Array.isArray(result.compose) ? result.compose : [];
}
