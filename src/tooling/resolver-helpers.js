import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { runSteps } from '../compose/runtime.js';
import { getRuntimeResolverRoot } from './runtime-locator.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');

let helperDefsCache = null;
const cache = new Map();

function getHelperDefinitions() {
  if (!helperDefsCache) {
    helperDefsCache = buildHelperDefinitions();
  }
  return helperDefsCache;
}

export function refreshResolverHelperCache() {
  helperDefsCache = null;
  cache.clear();
}

function buildHelperDefinitions() {
  const candidates = gatherResolverCandidates();
  const collected = [];
  for (const candidate of candidates) {
    const defs = loadDefinitionsForCandidate(candidate);
    if (defs.length > 0) {
      collected.push(...defs);
    }
  }
  return collected;
}

function gatherResolverCandidates() {
  const out = [];
  const runtimeResolverRoot = getRuntimeResolverRoot();
  if (runtimeResolverRoot) {
    out.push({ type: 'root', path: runtimeResolverRoot });
  }
  if (process.env.LCOD_RESOLVER_COMPONENTS_PATH) {
    out.push({ type: 'components', path: path.resolve(process.env.LCOD_RESOLVER_COMPONENTS_PATH) });
  }
  if (process.env.LCOD_RESOLVER_PATH) {
    out.push({ type: 'root', path: path.resolve(process.env.LCOD_RESOLVER_PATH) });
  }
  out.push({ type: 'root', path: path.resolve(repoRoot, '..', 'lcod-resolver') });
  out.push({ type: 'legacy', path: path.resolve(repoRoot, '..', 'lcod-spec', 'tooling', 'resolver') });
  out.push({ type: 'legacy', path: path.resolve(repoRoot, '..', 'lcod-spec', 'tooling', 'registry') });
  return out;
}

function loadDefinitionsForCandidate(candidate) {
  switch (candidate.type) {
    case 'root': {
      const workspaceDefs = loadWorkspaceDefinitions(candidate.path);
      if (workspaceDefs.length > 0) return workspaceDefs;
      const componentsDir = path.join(candidate.path, 'components');
      return loadLegacyComponentDefinitions(componentsDir);
    }
    case 'components':
      return loadLegacyComponentDefinitions(candidate.path);
    case 'legacy':
      return loadLegacyComponentDefinitions(candidate.path);
    default:
      return [];
  }
}

function loadWorkspaceDefinitions(rootPath) {
  const workspacePath = path.join(rootPath, 'workspace.lcp.toml');
  if (!fs.existsSync(workspacePath)) return [];
  let workspaceDoc;
  try {
    workspaceDoc = parseToml(fs.readFileSync(workspacePath, 'utf8'));
  } catch (err) {
    console.warn(`Failed to parse workspace manifest at ${workspacePath}: ${err.message || err}`);
    return [];
  }
  const workspace = workspaceDoc?.workspace || {};
  const packages = Array.isArray(workspace.packages) ? workspace.packages : [];
  if (packages.length === 0) return [];
  const aliasMap = workspace.scopeAliases && typeof workspace.scopeAliases === 'object'
    ? workspace.scopeAliases
    : {};
  const defs = [];
  for (const pkgName of packages) {
    if (typeof pkgName !== 'string' || !pkgName) continue;
    const pkgDir = path.join(rootPath, 'packages', pkgName);
    const manifestPath = path.join(pkgDir, 'lcp.toml');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = parseToml(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      console.warn(`Failed to parse package manifest at ${manifestPath}: ${err.message || err}`);
      continue;
    }
    const context = createWorkspaceContext(manifest, aliasMap);
    const workspaceComponents = manifest?.workspace?.components;
    if (!Array.isArray(workspaceComponents)) continue;
    for (const entry of workspaceComponents) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.path !== 'string') continue;
      const componentDir = path.join(pkgDir, entry.path);
      const composePath = path.join(componentDir, 'compose.yaml');
      if (!fs.existsSync(composePath)) continue;
      const canonicalId = canonicalizeId(entry.id, context);
      const def = {
        id: canonicalId,
        composePath,
        context,
        cacheKey: `${canonicalId}::${composePath}`,
        aliases: []
      };
      const componentManifestPath = path.join(componentDir, 'lcp.toml');
      if (fs.existsSync(componentManifestPath)) {
        try {
          const compManifest = parseToml(fs.readFileSync(componentManifestPath, 'utf8'));
          if (compManifest?.id && compManifest.id !== canonicalId) {
            def.aliases.push(compManifest.id);
          }
        } catch (_err) {
          // ignore malformed component manifest
        }
      }
      defs.push(def);
    }
  }
  return defs;
}

function createWorkspaceContext(manifest, aliasMap) {
  const id = typeof manifest?.id === 'string' ? manifest.id : null;
  const version = typeof manifest?.version === 'string'
    ? manifest.version
    : (id ? extractVersion(id) : undefined);
  const basePath = id ? extractPath(id) : buildPathFromFields(manifest);
  return {
    basePath,
    version,
    aliasMap: aliasMap || {}
  };
}

function extractPath(id) {
  const match = /^lcod:\/\/(.+)@/.exec(id);
  return match ? match[1] : null;
}

function extractVersion(id) {
  const match = /@([^@]+)$/.exec(id);
  return match ? match[1] : null;
}

function buildPathFromFields(manifest) {
  const ns = typeof manifest?.namespace === 'string' && manifest.namespace.length
    ? manifest.namespace
    : null;
  const name = typeof manifest?.name === 'string' ? manifest.name : null;
  return [ns, name].filter(Boolean).join('/');
}

function loadLegacyComponentDefinitions(componentsDir) {
  if (!componentsDir || !fs.existsSync(componentsDir)) return [];
  const entries = fs.readdirSync(componentsDir, { withFileTypes: true });
  const defs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const componentDir = path.join(componentsDir, entry.name);
    const composePath = path.join(componentDir, 'compose.yaml');
    if (!fs.existsSync(composePath)) continue;
    const manifestPath = path.join(componentDir, 'lcp.toml');
    let componentId;
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = parseToml(fs.readFileSync(manifestPath, 'utf8'));
        componentId = manifest?.id;
      } catch (_err) {
        // ignore malformed manifest
      }
    }
    if (!componentId || typeof componentId !== 'string') {
      // Skip components without an explicit ID — cannot register reliably
      continue;
    }
    defs.push({
      id: componentId,
      composePath,
      context: {
        basePath: extractPath(componentId)?.split('/').slice(0, -1).join('/') || null,
        version: extractVersion(componentId),
        aliasMap: {}
      },
      cacheKey: `${componentId}::${composePath}`,
      aliases: []
    });
  }
  return defs;
}

function canonicalizeId(rawId, context) {
  if (!rawId || typeof rawId !== 'string') return rawId;
  if (rawId.startsWith('lcod://')) return rawId;
  const cleaned = rawId.replace(/^\.\//, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) return rawId;
  const alias = segments[0];
  const mapped = context?.aliasMap?.[alias] ?? alias;
  const remainder = segments.slice(1);
  const base = context?.basePath ? [context.basePath] : [];
  const full = [...base, mapped, ...remainder].filter(Boolean).join('/');
  const version = context?.version || '0.0.0';
  return `lcod://${full}@${version}`;
}

function canonicalizeSteps(steps, context) {
  if (!Array.isArray(steps)) return steps;
  return steps.map(step => canonicalizeStep(step, context));
}

function canonicalizeStep(step, context) {
  if (!step || typeof step !== 'object') return step;
  const out = { ...step };
  if (typeof out.call === 'string') {
    out.call = canonicalizeId(out.call, context);
  }
  if (out.children) {
    if (Array.isArray(out.children)) {
      out.children = canonicalizeSteps(out.children, context);
    } else {
      const children = {};
      for (const [slot, branch] of Object.entries(out.children)) {
        children[slot] = canonicalizeSteps(Array.isArray(branch) ? branch : [], context);
      }
      out.children = children;
    }
  }
  if (out.in) out.in = canonicalizeValue(out.in, context);
  if (out.out) out.out = canonicalizeValue(out.out, context);
  if (out.bindings) out.bindings = canonicalizeValue(out.bindings, context);
  return out;
}

function canonicalizeValue(value, context) {
  if (Array.isArray(value)) return value.map(item => canonicalizeValue(item, context));
  if (value && typeof value === 'object') {
    if (typeof value.call === 'string') {
      return canonicalizeStep(value, context);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = canonicalizeValue(v, context);
    }
    return out;
  }
  return value;
}

async function loadHelper(def) {
  const key = def.cacheKey || def.id;
  if (cache.has(key)) return cache.get(key);

  const candidates = [def.composePath];
  let lastError;
  for (const candidate of candidates) {
    try {
      const raw = await fsp.readFile(candidate, 'utf8');
      const doc = YAML.parse(raw);
      if (!doc || !Array.isArray(doc.compose)) {
        throw new Error(`Invalid compose file: ${candidate}`);
      }
      const steps = canonicalizeSteps(doc.compose, def.context);
      const entry = { steps, path: candidate };
      cache.set(key, entry);
      return entry;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        lastError = err;
        continue;
      }
      throw new Error(
        `Failed to load resolver helper "${def.id}" from ${candidate}: ${err.message || err}`
      );
    }
  }
  throw new Error(
    `Unable to locate resolver helper "${def.id}". Last error: ${lastError?.message || 'not found'}`
  );
}

function ensureResolverAxiomFallbacks(registry) {
  const aliasContract = (contractId, axiomId) => {
    if (registry.get(axiomId)) return;
    const entry = registry.get(contractId);
    if (!entry) return;
    registry.register(axiomId, entry.fn, {
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      implements: entry.implements
    });
  };

  if (!registry.get('lcod://axiom/path/join@1')) {
    registry.register('lcod://axiom/path/join@1', async (_ctx, input = {}) => {
      const base = typeof input.base === 'string' ? input.base : String(input.base ?? '');
      const segment = typeof input.segment === 'string' ? input.segment : String(input.segment ?? '');
      return { path: path.join(base, segment) };
    });
  }

  aliasContract('lcod://contract/core/fs/read-file@1', 'lcod://axiom/fs/read-file@1');

  if (!registry.get('lcod://axiom/json/parse@1')) {
    registry.register('lcod://axiom/json/parse@1', async (_ctx, input = {}) => {
      const text = input.text;
      if (typeof text !== 'string') throw new Error('text is required');
      return { value: JSON.parse(text) };
    });
  }

  if (!registry.get('lcod://axiom/toml/parse@1')) {
    registry.register('lcod://axiom/toml/parse@1', async (_ctx, input = {}) => {
      const text = input.text;
      if (typeof text !== 'string') throw new Error('text is required');
      return { value: parseToml(text) };
    });
  }

  if (!registry.get('lcod://axiom/toml/stringify@1')) {
    registry.register('lcod://axiom/toml/stringify@1', async (_ctx, input = {}) => {
      const value = input.value ?? {};
      return { text: stringifyToml(value) };
    });
  }
}

export function registerResolverHelpers(registry) {
  ensureResolverAxiomFallbacks(registry);
  const helperDefs = getHelperDefinitions();
  for (const def of helperDefs) {
    const ids = [def.id, ...(def.aliases || [])];
    for (const id of ids) {
      registry.register(id, async (ctx, input = {}) => {
        const { steps } = await loadHelper(def);
        const resultState = await runSteps(ctx, steps, input);
        return resultState;
      });
    }
  }
  registry.register('lcod://tooling/resolver/register@1', async (_ctx, input = {}) => {
    const components = Array.isArray(input.components) ? input.components : [];
    const warnings = [];
    let count = 0;
    for (const component of components) {
      if (!component || typeof component !== 'object') continue;
      const context = component.context && typeof component.context === 'object'
        ? component.context
        : undefined;
      const rawId = typeof component.id === 'string' && component.id.length > 0
        ? component.id
        : null;
      if (!rawId) {
        warnings.push('resolver/register: missing component id');
        continue;
      }
      const canonicalId = canonicalizeId(rawId, context);
      if (typeof canonicalId !== 'string' || !canonicalId.startsWith('lcod://')) {
        warnings.push(`resolver/register: invalid component id "${rawId}"`);
        continue;
      }

      let steps;
      if (Array.isArray(component.compose)) {
        steps = canonicalizeSteps(component.compose, context);
      } else if (typeof component.composePath === 'string' && component.composePath.length > 0) {
        try {
          const raw = await fsp.readFile(component.composePath, 'utf8');
          const doc = YAML.parse(raw);
          if (!doc || !Array.isArray(doc.compose)) {
            warnings.push(`resolver/register: invalid compose file for ${canonicalId}: ${component.composePath}`);
            continue;
          }
          steps = canonicalizeSteps(doc.compose, context);
        } catch (err) {
          warnings.push(`resolver/register: failed to read ${component.composePath}: ${err.message || err}`);
          continue;
        }
      } else {
        warnings.push(`resolver/register: component ${canonicalId} missing compose data`);
        continue;
      }

      registry.register(canonicalId, async (ctx, payload = {}) => {
        const resultState = await runSteps(ctx, steps, payload);
        return resultState;
      });
      count += 1;
    }
    return {
      registered: count,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  });
  return registry;
}
