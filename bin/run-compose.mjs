#!/usr/bin/env node
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
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

const DEFAULT_CATALOGUE_URL = 'https://raw.githubusercontent.com/lcod-team/lcod-components/main/registry/components.std.jsonl';
const DEFAULT_COMPONENTS_REPO = 'https://github.com/lcod-team/lcod-components';
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;

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

function loadStateArg(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(raw);
  }
  const resolved = path.resolve(process.cwd(), raw);
  return readJson(resolved);
}

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

function registerFlowBlocks(reg) {
  reg.register('lcod://flow/if@1', flowIf);
  reg.register('lcod://flow/foreach@1', flowForeach);
  reg.register('lcod://flow/parallel@1', flowParallel);
  reg.register('lcod://flow/try@1', flowTry);
  reg.register('lcod://flow/throw@1', flowThrow);
  if (flowBreak) reg.register('lcod://flow/break@1', flowBreak);
  if (flowContinue) reg.register('lcod://flow/continue@1', flowContinue);
}

function isLcodIdentifier(value) {
  return typeof value === 'string' && value.startsWith('lcod://');
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

async function resolveComponentCompose(ctx, componentId) {
  try {
    const result = await ctx.call('lcod://resolver/locate_component@0.1.0', { componentId });
    if (result && result.found) {
      const resolved = typeof result.result === 'object' && result.result !== null
        ? result.result
        : {};
      const candidates = [
        typeof resolved.composePath === 'string' ? resolved.composePath : null,
        typeof resolved.compose?.path === 'string' ? resolved.compose.path : null
      ].filter((value) => typeof value === 'string' && value.length > 0);
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          const metadata = await loadManifestMetadata(candidate);
          return { steps: loadComposeFile(candidate), path: candidate, metadata };
        }
      }
      const specCandidate = await resolveComponentFromSpec(componentId);
      if (specCandidate) {
        const metadata = await loadManifestMetadata(specCandidate);
        return { steps: loadComposeFile(specCandidate), path: specCandidate, metadata };
      }
    }
  } catch (err) {
    console.warn(`Resolver locate_component failed for ${componentId}: ${err?.message || err}`);
  }

  try {
    const fallbackPath = await fallbackResolveComponent(componentId);
    const metadata = await loadManifestMetadata(fallbackPath);
    return { steps: loadComposeFile(fallbackPath), path: fallbackPath, metadata };
  } catch (err) {
    throw new Error(`Failed to resolve component ${componentId}: ${err?.message || err}`);
  }
}

async function resolveComponentFromSpec(componentId) {
  const { key } = splitComponentId(componentId);
  const segments = key.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const candidates = [];
  if (process.env.SPEC_REPO_PATH) {
    candidates.push(path.resolve(process.cwd(), process.env.SPEC_REPO_PATH));
  }
  if (process.env.LCOD_HOME) {
    candidates.push(path.resolve(process.cwd(), process.env.LCOD_HOME));
  }
  const repoRootCandidate = path.resolve(process.cwd(), '..', 'lcod-spec');
  candidates.push(repoRootCandidate);
  const siblingCandidate = path.resolve(process.cwd(), '..', '..', 'lcod-spec');
  candidates.push(siblingCandidate);

  for (const root of candidates) {
    if (!root) continue;
    const composeCandidate = path.join(root, ...segments, 'compose.yaml');
    if (await fileExists(composeCandidate)) {
      return composeCandidate;
    }
  }
  return null;
}

async function loadManifestMetadata(composePath) {
  if (!composePath) return null;
  const manifestPath = path.join(path.dirname(composePath), 'lcp.toml');
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const manifest = TOML.parse(raw);
    const inputs = manifest && typeof manifest.inputs === 'object'
      ? Object.keys(manifest.inputs)
      : [];
    const outputs = manifest && typeof manifest.outputs === 'object'
      ? Object.keys(manifest.outputs)
      : [];
    if (!inputs.length && !outputs.length) {
      return null;
    }
    return { inputs, outputs };
  } catch {
    return null;
  }
}

function ensureObjectState(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { state: { ...value }, wrapped: false };
  }
  return { state: { input: value }, wrapped: true };
}

function sanitizeInputState(state, metadata) {
  if (!metadata || !Array.isArray(metadata.inputs) || metadata.inputs.length === 0) {
    return { ...state };
  }
  const sanitized = {};
  for (const key of metadata.inputs) {
    sanitized[key] = Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
  }
  return sanitized;
}

function projectOutputs(result, metadata) {
  if (!metadata || !Array.isArray(metadata.outputs) || metadata.outputs.length === 0) {
    return result;
  }
  const source = result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : { value: result };
  const projected = {};
  for (const key of metadata.outputs) {
    projected[key] = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : null;
  }
  return projected;
}

async function fallbackResolveComponent(componentId) {
  const specLocal = await resolveComponentFromSpecRepo(componentId).catch(() => null);
  if (specLocal) {
    return specLocal;
  }
  const { key, version } = splitComponentId(componentId);
  const cacheRoot = await cacheRootDir();
  await fsp.mkdir(cacheRoot, { recursive: true });

  const cataloguePath = await ensureCatalogueCached(cacheRoot);
  const entry = await findCatalogueEntry(cataloguePath, componentId);
  if (!entry) {
    throw new Error(`Component ${componentId} not found in default catalogue`);
  }

  const safeKey = sanitizeComponentKey(key);
  const componentDir = path.join(cacheRoot, 'components', safeKey, version);
  await fsp.mkdir(componentDir, { recursive: true });

  const composePath = path.join(componentDir, 'compose.yaml');
  if (!(await fileExists(composePath))) {
    const composeUrl = buildComponentUrl(entry, entry.compose);
    if (!composeUrl) {
      throw new Error(`Catalogue entry for ${componentId} missing compose path`);
    }
    await downloadUrlToPath(composeUrl, composePath);
  }

  const lcpPath = extractLcpPath(entry.lcp);
  if (lcpPath) {
    const target = path.join(componentDir, 'lcp.toml');
    if (!(await fileExists(target))) {
      const lcpUrl = buildComponentUrl(entry, lcpPath);
      if (lcpUrl) {
        await downloadUrlToPath(lcpUrl, target);
      }
    }
  }

  if (!(await fileExists(composePath))) {
    throw new Error(`Component ${componentId} resolved via fallback but compose file missing`);
  }
  return composePath;
}

async function resolveComponentFromSpecRepo(componentId) {
  const specRoot = process.env.SPEC_REPO_PATH
    ? path.resolve(process.env.SPEC_REPO_PATH)
    : null;
  if (!specRoot) {
    return null;
  }
  const { key } = splitComponentId(componentId);
  const segments = key
    .split('/')
    .flatMap((segment) => segment.split('.'))
    .filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  const candidate = path.join(specRoot, ...segments, 'compose.yaml');
  if (await fileExists(candidate)) {
    return candidate;
  }
  return null;
}

function extractLcpPath(field) {
  if (!field) return null;
  if (typeof field === 'string') return field;
  if (typeof field === 'object') {
    if (typeof field.path === 'string' && field.path.length > 0) return field.path;
    if (typeof field.url === 'string' && field.url.length > 0) return field.url;
  }
  return null;
}

function splitComponentId(componentId) {
  if (typeof componentId !== 'string' || !componentId.startsWith('lcod://')) {
    throw new Error('component id must start with lcod://');
  }
  const trimmed = componentId.slice('lcod://'.length);
  const [identifier, version = '0.0.0'] = trimmed.split('@');
  if (!identifier) {
    throw new Error('component id missing identifier');
  }
  return { key: identifier, version };
}

function sanitizeComponentKey(key) {
  return key.replace(/[^a-zA-Z0-9]/g, '_');
}

async function cacheRootDir() {
  const home = os.homedir();
  if (!home) {
    throw new Error('Unable to locate home directory');
  }
  return path.join(home, '.lcod', 'cache');
}

async function manifestFromRoot(root) {
  if (!root) return null;
  const direct = path.join(root, 'manifest.jsonl');
  if (await fileExists(direct)) {
    return direct;
  }
  const nested = path.join(root, 'runtime', 'manifest.jsonl');
  if (await fileExists(nested)) {
    return nested;
  }
  return null;
}

async function runtimeManifestFromEnv() {
  const candidates = [];
  if (process.env.LCOD_HOME) candidates.push(process.env.LCOD_HOME);
  if (process.env.SPEC_REPO_PATH) candidates.push(process.env.SPEC_REPO_PATH);
  if (process.env.LCOD_COMPONENTS_PATH) candidates.push(process.env.LCOD_COMPONENTS_PATH);
  for (const candidate of candidates) {
    const manifest = await manifestFromRoot(candidate);
    if (manifest) {
      return manifest;
    }
  }
  return null;
}

async function ensureCatalogueCached(cacheRoot) {
  const localManifest = await runtimeManifestFromEnv();
  if (localManifest) {
    return localManifest;
  }

  const catalogueDir = path.join(cacheRoot, 'catalogues');
  await fsp.mkdir(catalogueDir, { recursive: true });
  const cataloguePath = path.join(catalogueDir, 'components.std.jsonl');
  let shouldRefresh = true;
  try {
    const stat = await fsp.stat(cataloguePath);
    const age = Date.now() - stat.mtimeMs;
    if (Number.isFinite(age) && age <= CATALOGUE_TTL_MS) {
      shouldRefresh = false;
    }
  } catch {}
  if (shouldRefresh) {
    await downloadUrlToPath(DEFAULT_CATALOGUE_URL, cataloguePath);
  }
  return cataloguePath;
}

async function findCatalogueEntry(cataloguePath, componentId) {
  const raw = await fsp.readFile(cataloguePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && entry.id === componentId) {
        return entry;
      }
    } catch {
      // ignore malformed line
    }
  }
  return null;
}

function buildComponentUrl(entry, manifestPath) {
  if (typeof manifestPath !== 'string' || !manifestPath) {
    return null;
  }
  const cleaned = manifestPath.trim().replace(/^\.\//, '');
  if (!cleaned) return null;
  const origin = entry && typeof entry.origin === 'object' ? entry.origin : {};
  const sourceRepo = origin.source_repo || origin.sourceRepo || DEFAULT_COMPONENTS_REPO;
  const commit = origin.commit || 'main';
  const rawBase = repoToRawBase(sourceRepo, commit);
  return `${rawBase}${cleaned}`;
}

function repoToRawBase(repo, commit) {
  if (typeof repo !== 'string' || !repo) {
    throw new Error('Repository URL missing from catalogue entry');
  }
  const normalized = repo.replace(/\/+$/, '');
  let suffix = normalized;
  if (normalized.startsWith('https://github.com/')) {
    suffix = normalized.slice('https://github.com/'.length);
  }
  if (!/^[^/]+\/[^/]+$/.test(suffix)) {
    throw new Error(`Unsupported repository URL: ${repo}`);
  }
  return `https://raw.githubusercontent.com/${suffix}/${commit}/`;
}

async function downloadUrlToPath(url, targetPath) {
  const buffer = await fetchBuffer(url);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, buffer);
}

async function fetchBuffer(url, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  if (typeof fetch === 'function') {
    const response = await fetch(url);
    if (response.status >= 300 && response.status < 400 && response.headers.get('location') && redirectCount < MAX_REDIRECTS) {
      const next = new URL(response.headers.get('location'), url).toString();
      if (typeof response.body?.cancel === 'function') {
        response.body.cancel().catch(() => {});
      }
      return fetchBuffer(next, redirectCount + 1);
    }
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  if (redirectCount >= MAX_REDIRECTS) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        fetchBuffer(next, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
  });
}

async function fileExists(targetPath) {
  try {
    const stat = await fsp.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
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
  const reg = new Registry();
  registerHttpContracts(reg);
  if (args.core) {
    registerNodeCore(reg);
    registerFlowBlocks(reg);
  }
  if (args.demo) {
    registerDemoAxioms(reg);
    // Register built-in flow blocks for demo usage
    if (!args.core) {
      registerFlowBlocks(reg);
    }
  }
  const needsResolverAxioms = args.resolver || isLcodIdentifier(args.compose);
  if (needsResolverAxioms) {
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
  let compose;
  let metadata = null;
  if (isLcodIdentifier(args.compose)) {
    const resolved = await resolveComponentCompose(ctx, args.compose);
    compose = resolved.steps;
    metadata = resolved.metadata ?? null;
  } else {
    const composePath = path.resolve(process.cwd(), args.compose);
    compose = loadComposeFile(composePath);
    metadata = await loadManifestMetadata(composePath);
  }
  let initial = args.state ? loadStateArg(args.state) : {};
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
  const { state: normalizedState, wrapped } = ensureObjectState(initial);
  if (wrapped) {
    console.warn('Input payload is not an object; wrapping under {"input": ...}');
  }
  const sanitizedState = sanitizeInputState(normalizedState, metadata);
  try {
    result = await runCompose(ctx, compose, sanitizedState);
  } catch (err) {
    if (err instanceof ExecutionCancelledError) {
      console.error('Execution cancelled');
      process.exit(130);
    }
    throw err;
  }
  const projectedResult = projectOutputs(result, metadata);
  console.log(JSON.stringify(projectedResult, null, 2));

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}

export { resolveComponentCompose, loadManifestMetadata };
