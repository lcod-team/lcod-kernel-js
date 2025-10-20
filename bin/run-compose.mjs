#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import TOML from '@iarna/toml';
import { Registry, Context, createCancellationToken, ExecutionCancelledError } from '../src/registry.js';
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
import { registerTooling } from '../src/tooling/index.js';
import { registerHttpContracts } from '../src/http/index.js';

function parseArgs(argv) {
  const args = {
    compose: null,
    demo: false,
    state: null,
    modules: null,
    bind: null,
    core: false,
    resolver: false,
    serve: false,
    project: null,
    config: null,
    output: null,
    cacheDir: null,
    sources: null,
    timeout: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--compose' || a === '-c') args.compose = argv[++i];
    else if (a === '--demo') args.demo = true;
    else if (a === '--core') args.core = true;
    else if (a === '--resolver') args.resolver = true;
    else if (a === '--serve') args.serve = true;
    else if (a === '--state' || a === '-s') args.state = argv[++i];
    else if (a === '--modules' || a === '-m') args.modules = argv[++i];
    else if (a === '--bind' || a === '-b') args.bind = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--cache-dir') args.cacheDir = argv[++i];
    else if (a === '--sources') args.sources = argv[++i];
    else if (a === '--timeout') args.timeout = argv[++i];
  }
  return args;
}

function parseDuration(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(\d+)(ms|s|m|h)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return amount * (multipliers[unit] || 1);
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
  const context = loadWorkspaceContext(path.dirname(p));
  canonicalizeCompose(data.compose, context);
  return data.compose;
}

function loadWorkspaceContext(dir) {
  const manifestPath = path.join(dir, 'lcp.toml');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = TOML.parse(fs.readFileSync(manifestPath, 'utf8'));
    const id = typeof manifest.id === 'string' ? manifest.id : null;
    const version = typeof manifest.version === 'string'
      ? manifest.version
      : (id && id.includes('@') ? id.split('@')[1] : null);
    let basePath = null;
    if (id && id.startsWith('lcod://')) {
      basePath = id.slice('lcod://'.length).split('@')[0];
    } else {
      const ns = typeof manifest.namespace === 'string' ? manifest.namespace : '';
      const name = typeof manifest.name === 'string' ? manifest.name : '';
      basePath = [ns, name].filter(Boolean).join('/');
    }
    const aliasMap = manifest.workspace?.scopeAliases && typeof manifest.workspace.scopeAliases === 'object'
      ? { ...manifest.workspace.scopeAliases }
      : {};
    if (!basePath || !version) {
      return { basePath: '', version: version || '0.0.0', aliasMap };
    }
    return { basePath, version, aliasMap };
  } catch (err) {
    console.warn(`Failed to parse manifest for compose in ${dir}: ${err.message || err}`);
    return null;
  }
}

function canonicalizeCompose(steps, context) {
  if (!context || !context.basePath || !context.version) return steps;
  if (!Array.isArray(steps)) return steps;
  for (const step of steps) {
    canonicalizeStep(step, context);
  }
  return steps;
}

function canonicalizeStep(step, context) {
  if (!step || typeof step !== 'object') return;
  if (typeof step.call === 'string') {
    step.call = canonicalizeId(step.call, context);
  }
  if (step.children) {
    if (Array.isArray(step.children)) {
      for (const child of step.children) canonicalizeStep(child, context);
    } else if (typeof step.children === 'object') {
      for (const key of Object.keys(step.children)) {
        const branch = step.children[key];
        if (Array.isArray(branch)) {
          for (const child of branch) canonicalizeStep(child, context);
        } else if (branch && typeof branch === 'object') {
          canonicalizeValue(branch, context);
        }
      }
    }
  }
  if (step.in) canonicalizeValue(step.in, context);
  if (step.out) canonicalizeValue(step.out, context);
  if (step.bindings) canonicalizeValue(step.bindings, context);
}

function canonicalizeValue(value, context) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) canonicalizeValue(item, context);
    return;
  }
  if (typeof value !== 'object') return;
  if (typeof value.call === 'string') {
    canonicalizeStep(value, context);
    return;
  }
  for (const key of Object.keys(value)) {
    canonicalizeValue(value[key], context);
  }
}

function canonicalizeId(raw, context) {
  if (typeof raw !== 'string') return raw;
  if (raw.startsWith('lcod://')) return raw;
  const segments = raw.replace(/^\.\//, '').split('/').filter(Boolean);
  if (segments.length === 0) return raw;
  const alias = segments[0];
  const mapped = context.aliasMap?.[alias] ?? alias;
  const remainder = segments.slice(1);
  const parts = [];
  if (context.basePath) parts.push(context.basePath);
  if (mapped) parts.push(mapped);
  if (remainder.length) parts.push(...remainder);
  if (!parts.length) return raw;
  const version = context.version || '0.0.0';
  return `lcod://${parts.join('/')}` + `@${version}`;
}

function collectHttpHosts(root) {
  const hosts = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value.server && typeof value.server.close === 'function') {
      hosts.push(value);
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      if (item && typeof item === 'object') queue.push(item);
    }
  }
  return hosts;
}

async function stopHost(host) {
  if (!host) return;
  if (typeof host.stop === 'function') {
    try {
      await host.stop();
      return;
    } catch (err) {
      console.error('Error while stopping host:', err?.message || err);
      return;
    }
  }
  if (host.server && typeof host.server.close === 'function') {
    await new Promise((resolve) => {
      host.server.close(() => resolve());
    });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cancellation = createCancellationToken();
  process.once('SIGINT', () => {
    if (!cancellation.isCancelled()) {
      console.error('Cancellation requested (Ctrl+C)');
      cancellation.cancel();
    }
  });
  process.once('SIGTERM', () => {
    if (!cancellation.isCancelled()) {
      console.error('Cancellation requested (SIGTERM)');
      cancellation.cancel();
    }
  });
  const timeoutMs = parseDuration(args.timeout);
  if (Number.isFinite(timeoutMs) && timeoutMs != null) {
    if (timeoutMs <= 0) {
      cancellation.cancel();
    } else {
      setTimeout(() => {
        if (!cancellation.isCancelled()) {
          console.error(`Execution timed out after ${timeoutMs} ms`);
          cancellation.cancel();
        }
      }, timeoutMs);
    }
  }
  if (args.resolver && !args.core) {
    args.core = true;
  }
  if (!args.compose) {
    console.error('Usage: run-compose --compose path/to/compose.yaml [--demo] [--resolver] [--sources sources.json] [--state state.json]');
    process.exit(2);
  }
  const composePath = path.resolve(process.cwd(), args.compose);
  const compose = loadComposeFile(composePath);
  const reg = new Registry();
  registerHttpContracts(reg);
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
  registerTooling(reg);
  if (reg.__toolingReady && typeof reg.__toolingReady.then === 'function') {
    await reg.__toolingReady;
  }
  if (args.modules) await loadModulesFromMap(reg, args.modules, { baseDir: process.cwd() });
  if (args.bind) {
    const bindingPath = path.resolve(process.cwd(), args.bind);
    const bindings = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    reg.setBindings(bindings);
  }
  const ctx = new Context(reg, { cancellation });
  let initial = args.state ? readJson(path.resolve(process.cwd(), args.state)) : {};
  if (args.resolver) {
    const state = { ...initial };
    const resolvedProject = args.project
      ? path.resolve(process.cwd(), args.project)
      : (typeof state.projectPath === 'string' && state.projectPath
          ? path.resolve(process.cwd(), state.projectPath)
          : process.cwd());
    state.projectPath = resolvedProject;
    if (args.config) {
      state.configPath = path.resolve(process.cwd(), args.config);
    }
    if (args.sources) {
      state.sourcesPath = path.resolve(process.cwd(), args.sources);
    }
    if (args.output) {
      state.outputPath = path.resolve(process.cwd(), args.output);
    } else if (!state.outputPath) {
      state.outputPath = path.join(resolvedProject, 'lcp.lock');
    }
    if (args.cacheDir) {
      process.env.LCOD_CACHE_DIR = path.resolve(process.cwd(), args.cacheDir);
    }
    initial = state;
  }
  let result;
  try {
    result = await runCompose(ctx, compose, initial);
  } catch (err) {
    if (err instanceof ExecutionCancelledError) {
      console.error('Execution cancelled');
      process.exit(130);
    }
    throw err;
  }
  console.log(JSON.stringify(result, null, 2));

  const hosts = collectHttpHosts(result);
  if (!hosts.length) return;

  if (args.serve) {
    console.log(`Serving ${hosts.length} HTTP host(s). Press Ctrl+C to stop.`);
    await new Promise((resolve) => {
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        await Promise.all(hosts.map(stopHost));
        resolve();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  } else {
    await Promise.all(hosts.map(stopHost));
  }
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
