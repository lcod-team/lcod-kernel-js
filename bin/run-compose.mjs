#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Registry, Context } from '../src/registry.js';
import { runCompose } from '../src/compose.js';
import { registerDemoAxioms } from '../src/axioms.js';

function parseArgs(argv) {
  const args = { compose: null, demo: false, state: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--compose' || a === '-c') args.compose = argv[++i];
    else if (a === '--demo') args.demo = true;
    else if (a === '--state' || a === '-s') args.state = argv[++i];
  }
  return args;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function main() {
  const args = parseArgs(process.argv);
  if (!args.compose) {
    console.error('Usage: run-compose --compose path/to/compose.json [--demo] [--state state.json]');
    process.exit(2);
  }
  const composePath = path.resolve(process.cwd(), args.compose);
  const compose = readJson(composePath).compose || [];
  const reg = new Registry();
  if (args.demo) registerDemoAxioms(reg);
  const ctx = new Context(reg);
  const initial = args.state ? readJson(path.resolve(process.cwd(), args.state)) : {};
  const result = await runCompose(ctx, compose, initial);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });

