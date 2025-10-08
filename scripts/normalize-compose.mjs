#!/usr/bin/env node
import fs from 'node:fs/promises';

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath) {
    console.error('Usage: normalize-compose <compose.json> [output.json]');
    process.exit(1);
  }

  const composeData = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const { normalizeCompose } = await import('../src/compose/normalizer.js');
  const normalized = await normalizeCompose(composeData.compose || []);

  const payload = { compose: normalized };
  if (outputPath) {
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2));
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
