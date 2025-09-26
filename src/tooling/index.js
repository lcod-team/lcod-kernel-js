import { registerTestChecker } from './test-checker.js';

export function registerTooling(registry) {
  registerTestChecker(registry);
  return registry;
}
