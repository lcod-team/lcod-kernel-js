#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import TOML from '@iarna/toml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error('Usage: node scripts/validate-lcp.mjs <component-dir-or-lcp.toml>');
  process.exit(2);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    throw new Error(`Invalid JSON at ${p}: ${e.message}`);
  }
}

function ensureFile(p, label) {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

async function main() {
  const target = process.argv[2];
  if (!target) usage();
  let lcpPath = path.resolve(process.cwd(), target);
  const stat = fs.existsSync(lcpPath) ? fs.statSync(lcpPath) : null;
  if (!stat) {
    console.error(`ERROR: Path not found ${lcpPath}`);
    process.exit(1);
  }
  if (stat.isDirectory()) lcpPath = path.join(lcpPath, 'lcp.toml');
  ensureFile(lcpPath, 'lcp.toml');
  const componentRoot = path.dirname(lcpPath);

  const schemaPath = path.resolve(__dirname, '../schema/lcp.schema.json');
  ensureFile(schemaPath, 'LCP schema');
  const schemaJson = readJson(schemaPath);

  const ajv = new Ajv2020({ strict: true, strictSchema: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(schemaJson);

  let descriptor;
  try {
    descriptor = TOML.parse(fs.readFileSync(lcpPath, 'utf8'));
  } catch (e) {
    console.error(`ERROR: Failed to parse ${lcpPath}: ${e.message}`);
    process.exit(1);
  }

  const ok = validate(descriptor);
  if (!ok) {
    for (const err of validate.errors ?? []) {
      const ptr = err.instancePath?.length ? err.instancePath : '/';
      console.error(`ERROR: ${ptr} ${err.message}`);
    }
    process.exit(1);
  }

  const schemaRefs = ['inputSchema', 'outputSchema'];
  for (const key of schemaRefs) {
    if (!descriptor.tool?.[key]) {
      console.error(`ERROR: tool.${key} missing`);
      process.exit(1);
    }
    const p = path.join(componentRoot, descriptor.tool[key]);
    ensureFile(p, `tool.${key}`);
    readJson(p);
  }
  if (descriptor.ui?.propsSchema) {
    const p = path.join(componentRoot, descriptor.ui.propsSchema);
    ensureFile(p, 'ui.propsSchema');
    readJson(p);
  }
  if (descriptor.docs?.readme) {
    const p = path.join(componentRoot, descriptor.docs.readme);
    ensureFile(p, 'docs.readme');
  }
  if (descriptor.docs?.logo) {
    const p = path.join(componentRoot, descriptor.docs.logo);
    ensureFile(p, 'docs.logo');
  }

  console.log(`OK: ${path.relative(process.cwd(), lcpPath)} validated`);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
