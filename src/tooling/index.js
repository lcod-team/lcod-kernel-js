import { registerTestChecker } from './test-checker.js';
import { registerScriptContract } from './script.js';
import { registerResolverHelpers } from './resolver-helpers.js';
import { registerRegistryScope } from './registry-scope.js';
import { registerLogging } from './logging.js';
import { registerRegistryComponents } from './registry-components.js';

export function registerTooling(registry) {
  registerTestChecker(registry);
  registerScriptContract(registry);
  registerResolverHelpers(registry);
  registerRegistryScope(registry);
  registerLogging(registry);
  const bootstrapPromise = Promise.resolve()
    .then(() => registerRegistryComponents(registry))
    .catch((err) => {
      console.warn(`[tooling] registry bootstrap failed: ${err?.message || err}`);
      throw err;
    });
  registry.__toolingReady = bootstrapPromise;
  return registry;
}
