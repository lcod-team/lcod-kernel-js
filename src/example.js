import { Registry, Context } from './registry.js';
import { registerDemoAxioms } from './axioms.js';
import { runCompose } from './compose.js';

async function main() {
  const reg = registerDemoAxioms(new Registry());
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

