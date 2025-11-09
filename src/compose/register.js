import { composeRunSlot } from './run_slot.js';

export function registerComposeContracts(registry) {
  registry.register('lcod://contract/compose/run_slot@1', composeRunSlot);
  return registry;
}
