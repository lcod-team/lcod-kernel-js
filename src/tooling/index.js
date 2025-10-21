import { registerTestChecker } from './test-checker.js';
import { registerScriptContract } from './script.js';
import { registerResolverHelpers } from './resolver-helpers.js';
import { registerRegistryScope } from './registry-scope.js';
import { registerLogging, logKernelWarn } from './logging.js';
import { registerRegistryComponents } from './registry-components.js';
import { registerStdHelpers } from './std-helpers.js';

export function registerTooling(registry) {
  registerTestChecker(registry);
  registerScriptContract(registry);
  registerResolverHelpers(registry);
  registerRegistryScope(registry);
  registerLogging(registry);
  registerStdHelpers(registry);
  const bootstrapPromise = Promise.resolve()
    .then(() => registerRegistryComponents(registry))
    .catch((err) => {
      logKernelWarn(null, 'Registry bootstrap failed', {
        data: { error: err?.message },
        tags: { module: 'tooling/index' }
      });
      throw err;
    });
  registry.__toolingReady = bootstrapPromise;
  return registry;
}
