import { registerTestChecker } from './test-checker.js';
import { registerScriptContract } from './script.js';

export function registerTooling(registry) {
  registerTestChecker(registry);
  registerScriptContract(registry);
  return registry;
}
