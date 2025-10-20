import { flowIf } from './if.js';
import { flowForeach } from './foreach.js';
import { flowParallel } from './parallel.js';
import { flowTry } from './try.js';
import { flowThrow } from './throw.js';
import { flowBreak } from './break.js';
import { flowContinue } from './continue.js';
import { flowCheckAbort } from './check_abort.js';
import { flowWhile } from './while.js';

export function registerFlowPrimitives(registry) {
  registry.register('lcod://flow/if@1', flowIf);
  registry.register('lcod://flow/foreach@1', flowForeach);
  registry.register('lcod://flow/parallel@1', flowParallel);
  registry.register('lcod://flow/try@1', flowTry);
  registry.register('lcod://flow/throw@1', flowThrow);
  registry.register('lcod://flow/break@1', flowBreak);
  registry.register('lcod://flow/continue@1', flowContinue);
  registry.register('lcod://flow/check_abort@1', flowCheckAbort);
  registry.register('lcod://flow/while@1', flowWhile);
  return registry;
}
