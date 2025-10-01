#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Registry, Context } from '../src/registry.js';
import { runCompose } from '../src/compose.js';
import { registerDemoAxioms } from '../src/axioms.js';
import { flowIf } from '../src/flow/if.js';
import { flowForeach } from '../src/flow/foreach.js';
import { flowBreak } from '../src/flow/break.js';
import { flowContinue } from '../src/flow/continue.js';
import { flowTry } from '../src/flow/try.js';
import { flowThrow } from '../src/flow/throw.js';
import { flowParallel } from '../src/flow/parallel.js';
import { loadModulesFromMap } from '../src/loaders.js';
import { registerNodeCore, registerNodeResolverAxioms } from '../src/core/index.js';

function parseArgs(argv) {
  const args = { compose: null, demo: false, state: null, modules: null, bind: null, core: false, resolver: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--compose' || a === '-c') args.compose = argv[++i];
    else if (a === '--demo') args.demo = true;
    else if (a === '--core') args.core = true;
    else if (a === '--resolver') args.resolver = true;
    else if (a === '--state' || a === '-s') args.state = argv[++i];
    else if (a === '--modules' || a === '-m') args.modules = argv[++i];
    else if (a === '--bind' || a === '-b') args.bind = argv[++i];
  }
  return args;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function loadComposeFile(p) {
  const text = fs.readFileSync(p, 'utf8');
  const ext = path.extname(p).toLowerCase();
  let data;
  if (ext === '.yaml' || ext === '.yml') {
    data = YAML.parse(text);
  } else {
    data = JSON.parse(text);
  }
  if (!data || !Array.isArray(data.compose)) {
    throw new Error(`Invalid compose file: ${p}`);
  }
  return data.compose;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.compose) {
    console.error('Usage: run-compose --compose path/to/compose.yaml [--demo] [--state state.json]');
    process.exit(2);
  }
  const composePath = path.resolve(process.cwd(), args.compose);
  const compose = loadComposeFile(composePath);
  const reg = new Registry();
  if (args.core) {
    registerNodeCore(reg);
    reg.register('lcod://flow/if@1', flowIf);
    reg.register('lcod://flow/foreach@1', flowForeach);
    reg.register('lcod://flow/parallel@1', flowParallel);
    reg.register('lcod://flow/try@1', flowTry);
    reg.register('lcod://flow/throw@1', flowThrow);
    if (flowBreak) reg.register('lcod://flow/break@1', flowBreak);
    if (flowContinue) reg.register('lcod://flow/continue@1', flowContinue);
  }
  if (args.demo) {
    registerDemoAxioms(reg);
    // Register built-in flow blocks for demo usage
    if (!args.core) {
      reg.register('lcod://flow/if@1', flowIf);
      reg.register('lcod://flow/foreach@1', flowForeach);
      reg.register('lcod://flow/parallel@1', flowParallel);
      reg.register('lcod://flow/try@1', flowTry);
      reg.register('lcod://flow/throw@1', flowThrow);
      if (flowBreak) reg.register('lcod://flow/break@1', flowBreak);
      if (flowContinue) reg.register('lcod://flow/continue@1', flowContinue);
    }
  }
  if (args.resolver) {
    registerNodeResolverAxioms(reg);
  }
  if (args.modules) await loadModulesFromMap(reg, args.modules, { baseDir: process.cwd() });
  if (args.bind) {
    const bindingPath = path.resolve(process.cwd(), args.bind);
    const bindings = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    reg.setBindings(bindings);
  }
  const ctx = new Context(reg);
  const initial = args.state ? readJson(path.resolve(process.cwd(), args.state)) : {};
  const result = await runCompose(ctx, compose, initial);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
