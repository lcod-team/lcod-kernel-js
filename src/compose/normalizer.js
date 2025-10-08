import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Registry, Context } from '../registry.js';
import { runSteps } from './runtime.js';
import { registerTooling } from '../tooling/index.js';

const specRoot = process.env.LCOD_SPEC_PATH
  ? path.resolve(process.env.LCOD_SPEC_PATH)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'lcod-spec');

const normalizerComposePath = path.join(
  specRoot,
  'tooling',
  'compose',
  'normalize',
  'compose.yaml'
);

let cachedStepsPromise;
async function loadNormalizerSteps() {
  if (!cachedStepsPromise) {
    cachedStepsPromise = (async () => {
      let raw;
      try {
        raw = await fs.readFile(normalizerComposePath, 'utf8');
      } catch (err) {
        throw new Error(`Unable to read compose normalizer component at ${normalizerComposePath}: ${err.message || err}`);
      }
      const doc = YAML.parse(raw);
      if (!doc || !Array.isArray(doc.compose)) {
        throw new Error(`Invalid compose file for normalizer: ${normalizerComposePath}`);
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
