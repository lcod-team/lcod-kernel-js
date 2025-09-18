import { Registry, Context } from './registry.js';
import { registerDemoAxioms } from './axioms.js';
import { runCompose } from './compose.js';
import { flowIf } from './flow/if.js';
import { flowForeach } from './flow/foreach.js';
import { flowParallel } from './flow/parallel.js';
import { flowTry } from './flow/try.js';
import { flowThrow } from './flow/throw.js';
import { flowBreak } from './flow/break.js';
import { flowContinue } from './flow/continue.js';

async function main() {
  const reg = registerDemoAxioms(new Registry());
  // Register flow implementations as normal components (POC)
  reg.register('lcod://flow/if@1', flowIf);
  reg.register('lcod://flow/foreach@1', flowForeach);
  reg.register('lcod://flow/parallel@1', flowParallel);
  reg.register('lcod://flow/try@1', flowTry);
  reg.register('lcod://flow/throw@1', flowThrow);
  reg.register('lcod://flow/break@1', flowBreak);
  reg.register('lcod://flow/continue@1', flowContinue);
  const ctx = new Context(reg);

  const flow = {
    compose: [
      { call: 'lcod://core/localisation@1', in: {}, out: { gps: 'gps' } },
      { call: 'lcod://core/extract_city@1', in: { gps: '$.gps' }, out: { city: 'city' } },
      { call: 'lcod://core/weather@1', in: { city: '$.city' }, out: { tempC: 'tempC' } }
    ]
  };

  const result = await runCompose(ctx, flow.compose, {});
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
