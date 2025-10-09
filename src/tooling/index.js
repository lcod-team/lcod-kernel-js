import { registerTestChecker } from './test-checker.js';
import { registerScriptContract } from './script.js';
import { registerResolverHelpers } from './resolver-helpers.js';
import { registerRegistryScope } from './registry-scope.js';

export function registerTooling(registry) {
  registerTestChecker(registry);
  registerScriptContract(registry);
  registerResolverHelpers(registry);
  registerRegistryScope(registry);
  return registry;
}
