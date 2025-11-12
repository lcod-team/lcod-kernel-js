import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { runSteps } from '../compose/runtime.js';
import { getRuntimeResolverRoot } from './runtime-locator.js';
import { logKernelWarn } from './logging.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');

let helperDefsCache = null;
const cache = new Map();

function extractManifestKeys(section) {
  if (!section || typeof section !== 'object' || section === null) {
    return [];
  }
  return Object.keys(section);
}

function loadComponentMetadata(manifestPath) {
  try {
    const manifest = parseToml(fs.readFileSync(manifestPath, 'utf8'));
    return {
      inputs: extractManifestKeys(manifest.inputs),
      outputs: extractManifestKeys(manifest.outputs),
      slots: extractManifestKeys(manifest.slots)
    };
  } catch {
    return null;
  }
}

function loadManifestOutputs(manifestPath) {
  const metadata = loadComponentMetadata(manifestPath);
  return metadata ? metadata.outputs : [];
}

function metadataForComposePath(composePath) {
  if (!composePath || typeof composePath !== 'string') {
    return null;
  }
  const manifestPath = path.join(path.dirname(composePath), 'lcp.toml');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return loadComponentMetadata(manifestPath);
}

function cloneMetadata(meta) {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  const inputs = Array.isArray(meta.inputs) ? dedupeStrings(meta.inputs) : [];
  const outputs = Array.isArray(meta.outputs) ? dedupeStrings(meta.outputs) : [];
  const slots = Array.isArray(meta.slots) ? dedupeStrings(meta.slots) : [];
  if (!inputs.length && !outputs.length && !slots.length) {
    return null;
  }
  return {
    inputs,
    outputs,
    slots
  };
}

function dedupeStrings(list) {
  return [...new Set(list.filter((item) => typeof item === 'string' && item.length > 0))];
}

function buildRegisterOptions(metadata, outputs) {
  const normalizedMetadata = cloneMetadata(metadata);
  let normalizedOutputs = Array.isArray(outputs) && outputs.length > 0
    ? dedupeStrings(outputs)
    : null;
  if (!normalizedOutputs && normalizedMetadata && normalizedMetadata.outputs.length > 0) {
    normalizedOutputs = [...normalizedMetadata.outputs];
  }
  const options = {};
  if (normalizedMetadata) {
    options.metadata = normalizedMetadata;
  }
  if (normalizedOutputs && normalizedOutputs.length > 0) {
    options.outputs = normalizedOutputs;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

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
  ensureFallbackHelperDefinitions(collected);
  return collected;
}

function gatherResolverCandidates() {
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || !entry.path) return;
    const key = `${entry.type}:${entry.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  const addWorkspaceSources = (candidatePath) => {
    if (!candidatePath) return;
    const normalized = path.resolve(candidatePath);
    if (!fs.existsSync(normalized)) return;
    let handled = false;
    if (fs.existsSync(path.join(normalized, 'workspace.lcp.toml'))) {
      push({ type: 'root', path: normalized });
      handled = true;
    }
    const componentsDir = path.join(normalized, 'components');
    if (fs.existsSync(componentsDir)) {
      push({ type: 'components', path: componentsDir });
      handled = true;
    }
    const stdComponents = path.join(normalized, 'packages', 'std', 'components');
    if (fs.existsSync(stdComponents)) {
      push({ type: 'components', path: stdComponents });
      handled = true;
    }
    if (!handled) {
      try {
        if (fs.statSync(normalized).isDirectory()) {
          push({ type: 'components', path: normalized });
        }
      } catch {
        // ignore
      }
    }
  };

  const addWorkspacePathList = (value) => {
    if (!value) return;
    for (const entry of value.split(path.delimiter).map((item) => item.trim()).filter(Boolean)) {
      addWorkspaceSources(entry);
    }
  };

  const runtimeResolverRoot = getRuntimeResolverRoot();
  if (runtimeResolverRoot) {
    push({ type: 'root', path: runtimeResolverRoot });
  }
  if (process.env.LCOD_RESOLVER_COMPONENTS_PATH) {
    addWorkspacePathList(process.env.LCOD_RESOLVER_COMPONENTS_PATH);
  }
  if (process.env.LCOD_RESOLVER_PATH) {
    addWorkspacePathList(process.env.LCOD_RESOLVER_PATH);
  }
  if (process.env.LCOD_COMPONENTS_PATH) {
    addWorkspacePathList(process.env.LCOD_COMPONENTS_PATH);
  }
  if (process.env.LCOD_COMPONENTS_PATHS) {
    addWorkspacePathList(process.env.LCOD_COMPONENTS_PATHS);
  }
  if (process.env.LCOD_WORKSPACE_PATHS) {
    addWorkspacePathList(process.env.LCOD_WORKSPACE_PATHS);
  }
  addWorkspaceSources(process.cwd());
  const specToolingRoot = path.resolve(repoRoot, '..', 'lcod-spec', 'tooling');
  push({ type: 'legacy', path: path.join(specToolingRoot, 'resolver') });
  push({ type: 'legacy', path: path.join(specToolingRoot, 'registry') });
  push({ type: 'legacy', path: specToolingRoot });
  push({ type: 'root', path: path.resolve(repoRoot, '..', 'lcod-resolver') });
  const localComponentsRoot = path.resolve(repoRoot, '..', 'lcod-components');
  addWorkspaceSources(localComponentsRoot);
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
    void logKernelWarn(null, 'Failed to parse workspace manifest', {
      data: { workspacePath, error: err?.message },
      tags: { module: 'resolver-helpers' }
    });
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
      void logKernelWarn(null, 'Failed to parse package manifest', {
        data: { manifestPath, error: err?.message },
        tags: { module: 'resolver-helpers' }
      });
      continue;
    }
    const context = createWorkspaceContext(manifest, aliasMap);
    const workspaceComponents = manifest?.workspace?.components;
    if (Array.isArray(workspaceComponents)) {
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
            const manifestMetadata = loadComponentMetadata(componentManifestPath);
            if (manifestMetadata) {
              def.outputs = manifestMetadata.outputs;
              def.inputs = manifestMetadata.inputs;
              def.slots = manifestMetadata.slots;
              def.metadata = manifestMetadata;
            }
          } catch (err) {
            void logKernelWarn(null, 'Failed to parse component manifest', {
              data: { componentManifestPath, error: err?.message },
              tags: { module: 'resolver-helpers' }
            });
          }
        }
        defs.push(def);
      }
    }

    const componentsDir = typeof manifest?.workspace?.componentsDir === 'string'
      ? manifest.workspace.componentsDir.trim()
      : '';
    if (componentsDir) {
      const resolvedDir = path.isAbsolute(componentsDir)
        ? componentsDir
        : path.join(pkgDir, componentsDir);
      const componentDirs = collectComponentDirectories(resolvedDir);
      for (const componentDir of componentDirs) {
        const composePath = path.join(componentDir, 'compose.yaml');
        const manifestPath = path.join(componentDir, 'lcp.toml');
        if (!fs.existsSync(composePath) || !fs.existsSync(manifestPath)) continue;
        let componentManifest;
        try {
          componentManifest = parseToml(fs.readFileSync(manifestPath, 'utf8'));
        } catch (err) {
          void logKernelWarn(null, 'Failed to parse component manifest', {
            data: { manifestPath, error: err?.message },
            tags: { module: 'resolver-helpers' }
          });
          continue;
        }
        const rawId = typeof componentManifest?.id === 'string' ? componentManifest.id : null;
        if (!rawId) continue;
        const canonicalId = canonicalizeId(rawId, context);
        const def = {
          id: canonicalId,
          composePath,
          context,
          cacheKey: `${canonicalId}::${composePath}`,
          aliases: []
        };
        if (rawId !== canonicalId) {
          def.aliases.push(rawId);
        }
        const manifestMetadata = loadComponentMetadata(manifestPath);
        if (manifestMetadata) {
          def.outputs = manifestMetadata.outputs;
          def.inputs = manifestMetadata.inputs;
          def.slots = manifestMetadata.slots;
          def.metadata = manifestMetadata;
        }
        defs.push(def);
      }
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
  const defs = [];
  const visit = (currentDir) => {
    if (!currentDir || !fs.existsSync(currentDir)) return;
    const composePath = path.join(currentDir, 'compose.yaml');
    if (fs.existsSync(composePath)) {
      const manifestPath = path.join(currentDir, 'lcp.toml');
      let componentId;
      let manifestOutputs = [];
      let manifestInputs = [];
      let manifestSlots = [];
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = parseToml(fs.readFileSync(manifestPath, 'utf8'));
          componentId = manifest?.id;
          manifestOutputs = extractManifestKeys(manifest?.outputs);
          manifestInputs = extractManifestKeys(manifest?.inputs);
          manifestSlots = extractManifestKeys(manifest?.slots);
        } catch (err) {
          void logKernelWarn(null, 'Failed to parse legacy component manifest', {
            data: { manifestPath, error: err?.message },
            tags: { module: 'resolver-helpers' }
          });
        }
      }
      if (componentId && typeof componentId === 'string') {
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
        if (manifestOutputs.length > 0) {
          defs[defs.length - 1].outputs = manifestOutputs;
        }
        if (manifestInputs.length > 0 || manifestSlots.length > 0) {
          defs[defs.length - 1].metadata = {
            inputs: manifestInputs,
            outputs: manifestOutputs,
            slots: manifestSlots
          };
        }
      }
      return;
    }
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      visit(path.join(currentDir, entry.name));
    }
  };
  visit(componentsDir);
  return defs;
}

function collectComponentDirectories(rootDir) {
  const collected = [];
  const visit = (currentDir) => {
    if (!currentDir || !fs.existsSync(currentDir)) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    let hasManifest = false;
    let hasCompose = false;
    const subdirs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        subdirs.push(path.join(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'lcp.toml') hasManifest = true;
      if (entry.name === 'compose.yaml') hasCompose = true;
    }
    if (hasManifest && hasCompose) {
      collected.push(currentDir);
    }
    for (const subdir of subdirs) {
      visit(subdir);
    }
  };
  visit(rootDir);
  return collected;
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

function ensureFallbackHelperDefinitions(collected) {
  const ids = new Set(collected.map((def) => def.id));
  const specRoot = locateSpecRepo();
  if (specRoot) {
    const ensureHelper = (id, composeRelPath, basePath, version = '0.1.0') => {
      if (ids.has(id)) return;
      const composePath = path.join(specRoot, ...composeRelPath);
      if (!fs.existsSync(composePath)) return;
      const manifestPath = path.join(specRoot, ...composeRelPath.slice(0, -1), 'lcp.toml');
      const componentMetadata = fs.existsSync(manifestPath) ? loadComponentMetadata(manifestPath) : null;
      const outputs = componentMetadata ? componentMetadata.outputs : [];
      const def = {
        id,
        composePath,
        context: {
          basePath,
          version,
          aliasMap: {}
        },
        cacheKey: `${id}::${composePath}`,
        aliases: []
      };
      if (componentMetadata) {
        def.outputs = componentMetadata.outputs;
        def.inputs = componentMetadata.inputs;
        def.slots = componentMetadata.slots;
        def.metadata = componentMetadata;
      } else if (outputs.length > 0) {
        def.outputs = outputs;
      }
      collected.push(def);
    };

    const entries = [
      ['lcod://tooling/value/default_object@0.1.0', ['tooling', 'value', 'default_object', 'compose.yaml'], 'tooling/value/default_object'],
      ['lcod://tooling/value/default_array@0.1.0', ['tooling', 'value', 'default_array', 'compose.yaml'], 'tooling/value/default_array'],
      ['lcod://tooling/value/is_object@0.1.0', ['tooling', 'value', 'is_object', 'compose.yaml'], 'tooling/value/is_object'],
      ['lcod://tooling/value/is_array@0.1.0', ['tooling', 'value', 'is_array', 'compose.yaml'], 'tooling/value/is_array'],
      ['lcod://tooling/value/is_string_nonempty@0.1.0', ['tooling', 'value', 'is_string_nonempty', 'compose.yaml'], 'tooling/value/is_string_nonempty'],
      ['lcod://tooling/array/append@0.1.0', ['tooling', 'array', 'append', 'compose.yaml'], 'tooling/array/append'],
      ['lcod://tooling/array/compact@0.1.0', ['tooling', 'array', 'compact', 'compose.yaml'], 'tooling/array/compact'],
      ['lcod://tooling/array/concat@0.1.0', ['tooling', 'array', 'concat', 'compose.yaml'], 'tooling/array/concat'],
      ['lcod://tooling/array/filter_objects@0.1.0', ['tooling', 'array', 'filter_objects', 'compose.yaml'], 'tooling/array/filter_objects'],
      ['lcod://tooling/array/length@0.1.0', ['tooling', 'array', 'length', 'compose.yaml'], 'tooling/array/length'],
      ['lcod://tooling/array/shift@0.1.0', ['tooling', 'array', 'shift', 'compose.yaml'], 'tooling/array/shift'],
      ['lcod://tooling/fs/read_optional@0.1.0', ['tooling', 'fs', 'read_optional', 'compose.yaml'], 'tooling/fs/read_optional'],
      ['lcod://tooling/json/decode_object@0.1.0', ['tooling', 'json', 'decode_object', 'compose.yaml'], 'tooling/json/decode_object'],
      ['lcod://tooling/hash/sha256_base64@0.1.0', ['tooling', 'hash', 'sha256_base64', 'compose.yaml'], 'tooling/hash/sha256_base64'],
      ['lcod://tooling/path/join_chain@0.1.0', ['tooling', 'path', 'join_chain', 'compose.yaml'], 'tooling/path/join_chain'],
      ['lcod://tooling/path/dirname@0.1.0', ['tooling', 'path', 'dirname', 'compose.yaml'], 'tooling/path/dirname'],
      ['lcod://tooling/path/is_absolute@0.1.0', ['tooling', 'path', 'is_absolute', 'compose.yaml'], 'tooling/path/is_absolute'],
      ['lcod://tooling/path/to_file_url@0.1.0', ['tooling', 'path', 'to_file_url', 'compose.yaml'], 'tooling/path/to_file_url'],
      ['lcod://tooling/make_component_doc@0.1.0', ['tooling', 'make_component_doc', 'compose.yaml'], 'tooling/make_component_doc'],
      ['lcod://tooling/make_package_doc@0.1.0', ['tooling', 'make_package_doc', 'compose.yaml'], 'tooling/make_package_doc'],
      ['lcod://core/array/append@0.1.0', ['core', 'array', 'append', 'compose.yaml'], 'core/array/append'],
      ['lcod://core/json/decode@0.1.0', ['core', 'json', 'decode', 'compose.yaml'], 'core/json/decode'],
      ['lcod://core/json/encode@0.1.0', ['core', 'json', 'encode', 'compose.yaml'], 'core/json/encode'],
      ['lcod://core/object/merge@0.1.0', ['core', 'object', 'merge', 'compose.yaml'], 'core/object/merge'],
      ['lcod://core/string/format@0.1.0', ['core', 'string', 'format', 'compose.yaml'], 'core/string/format'],
      ['lcod://tooling/registry/source/load@0.1.0', ['tooling', 'registry', 'source', 'compose.yaml'], 'tooling/registry/source'],
      ['lcod://tooling/registry/index@0.1.0', ['tooling', 'registry', 'index', 'compose.yaml'], 'tooling/registry/index'],
      ['lcod://tooling/registry/select@0.1.0', ['tooling', 'registry', 'select', 'compose.yaml'], 'tooling/registry/select'],
      ['lcod://tooling/registry/resolution@0.1.0', ['tooling', 'registry', 'resolution', 'compose.yaml'], 'tooling/registry/resolution'],
      ['lcod://tooling/registry/catalog/generate@0.1.0', ['tooling', 'registry', 'catalog', 'compose.yaml'], 'tooling/registry/catalog'],
      ['lcod://tooling/registry_sources/build_inline_entry@0.1.0', ['tooling', 'registry_sources', 'build_inline_entry', 'compose.yaml'], 'tooling/registry_sources/build_inline_entry'],
      ['lcod://tooling/registry_sources/collect_entries@0.1.0', ['tooling', 'registry_sources', 'collect_entries', 'compose.yaml'], 'tooling/registry_sources/collect_entries'],
      ['lcod://tooling/registry_sources/collect_queue@0.1.0', ['tooling', 'registry_sources', 'collect_queue', 'compose.yaml'], 'tooling/registry_sources/collect_queue'],
      ['lcod://tooling/registry_sources/load_config@0.1.0', ['tooling', 'registry_sources', 'load_config', 'compose.yaml'], 'tooling/registry_sources/load_config'],
      ['lcod://tooling/registry_sources/merge_inline_entries@0.1.0', ['tooling', 'registry_sources', 'merge_inline_entries', 'compose.yaml'], 'tooling/registry_sources/merge_inline_entries'],
      ['lcod://tooling/registry_sources/normalize_pointer@0.1.0', ['tooling', 'registry_sources', 'normalize_pointer', 'compose.yaml'], 'tooling/registry_sources/normalize_pointer'],
      ['lcod://tooling/registry_sources/partition_normalized@0.1.0', ['tooling', 'registry_sources', 'partition_normalized', 'compose.yaml'], 'tooling/registry_sources/partition_normalized'],
      ['lcod://tooling/registry_sources/prepare_env@0.1.0', ['tooling', 'registry_sources', 'prepare_env', 'compose.yaml'], 'tooling/registry_sources/prepare_env'],
      ['lcod://tooling/registry_sources/process_catalogue@0.1.0', ['tooling', 'registry_sources', 'process_catalogue', 'compose.yaml'], 'tooling/registry_sources/process_catalogue'],
      ['lcod://tooling/registry_sources/process_pointer@0.1.0', ['tooling', 'registry_sources', 'process_pointer', 'compose.yaml'], 'tooling/registry_sources/process_pointer'],
      ['lcod://tooling/registry_sources/resolve@0.1.0', ['tooling', 'registry_sources', 'resolve', 'compose.yaml'], 'tooling/registry_sources/resolve'],
      ['lcod://tooling/resolver/context/prepare@0.1.0', ['tooling', 'resolver', 'context', 'compose.yaml'], 'tooling/resolver/context'],
      ['lcod://tooling/resolver/replace/apply@0.1.0', ['tooling', 'resolver', 'replace', 'compose.yaml'], 'tooling/resolver/replace'],
      ['lcod://tooling/resolver/warnings/merge@0.1.0', ['tooling', 'resolver', 'warnings', 'compose.yaml'], 'tooling/resolver/warnings'],
      ['lcod://tooling/resolver/register_components@0.1.0', ['tooling', 'resolver', 'register_components', 'compose.yaml'], 'tooling/resolver/register_components'],
    ];

    for (const [id, relPath, basePath] of entries) {
      ensureHelper(id, relPath, basePath);
    }
  }
}

function locateSpecRepo() {
  const candidates = [];
  if (process.env.SPEC_REPO_PATH) {
    candidates.push(path.resolve(process.env.SPEC_REPO_PATH));
  }
  candidates.push(path.resolve(repoRoot, '..', 'lcod-spec'));
  candidates.push(path.resolve(process.cwd(), '..', 'lcod-spec'));
  candidates.push(path.resolve(process.cwd(), '../lcod-spec'));
  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(candidate);
      if (!stats.isDirectory()) continue;
      const catalogCompose = path.join(candidate, 'tooling', 'registry', 'catalog', 'compose.yaml');
      if (fs.existsSync(catalogCompose)) {
        return candidate;
      }
    } catch (_) {
      // ignore missing candidate
    }
  }
  return null;
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

  if (!registry.get('lcod://tooling/fs/read_optional@0.1.0')) {
    registry.register('lcod://tooling/fs/read_optional@0.1.0', async (_ctx, input = {}) => {
      const targetPath = typeof input.path === 'string' && input.path.length > 0 ? input.path : null;
      const encoding = typeof input.encoding === 'string' && input.encoding.length > 0
        ? input.encoding
        : 'utf-8';
      const fallback = typeof input.fallback === 'string' ? input.fallback : '';
      const warningTemplate = typeof input.warningMessage === 'string' && input.warningMessage.length > 0
        ? input.warningMessage
        : null;

      if (!targetPath) {
        return { text: fallback, exists: false, warning: warningTemplate };
      }

      try {
        const content = await fsp.readFile(targetPath, { encoding });
        return { text: content, exists: true, warning: null };
      } catch (err) {
        const message = warningTemplate || err?.message || `Failed to read ${targetPath}`;
        return { text: fallback, exists: false, warning: message };
      }
    });
  }
}

export function registerResolverHelpers(registry) {
  ensureResolverAxiomFallbacks(registry);
  registerResolveDependenciesContract(registry);
  const helperDefs = getHelperDefinitions();
  for (const def of helperDefs) {
    const ids = [def.id, ...(def.aliases || [])];
    const definitionMetadata = def.metadata || metadataForComposePath(def.composePath);
    const outputs = Array.isArray(def.outputs) && def.outputs.length > 0
      ? [...def.outputs]
      : (definitionMetadata?.outputs?.length ? [...definitionMetadata.outputs] : null);
    const registerOptions = buildRegisterOptions(definitionMetadata, outputs);
    for (const id of ids) {
      registry.register(id, async (ctx, input = {}) => {
        const { steps } = await loadHelper(def);
        return runSteps(ctx, steps, input);
      }, registerOptions);
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

      let declaredOutputs = [];
      let declaredInputs = [];
      if (Array.isArray(component.outputs)) {
        declaredOutputs = component.outputs.filter((item) => typeof item === 'string');
      } else if (typeof component.composePath === 'string' && component.composePath.length > 0) {
        const manifestPath = path.join(path.dirname(component.composePath), 'lcp.toml');
        if (fs.existsSync(manifestPath)) {
          declaredOutputs = loadManifestOutputs(manifestPath);
        }
      }
      if (Array.isArray(component.inputs)) {
        declaredInputs = component.inputs.filter((item) => typeof item === 'string');
      }

      let metadata = null;
      if (typeof component.composePath === 'string' && component.composePath.length > 0) {
        metadata = metadataForComposePath(component.composePath);
      }
      if (metadata && declaredInputs.length) {
        metadata.inputs = declaredInputs;
      } else if (!metadata && declaredInputs.length) {
        metadata = { inputs: declaredInputs, outputs: [], slots: [] };
      }
      const outputs = declaredOutputs.length > 0 ? declaredOutputs : null;

      const registerOptions = buildRegisterOptions(metadata, outputs);
      registry.register(canonicalId, async (ctx, payload = {}) => {
        return runSteps(ctx, steps, payload);
      }, registerOptions);
      count += 1;
    }
    return {
      registered: count,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  });
  return registry;
}

function registerResolveDependenciesContract(registry) {
  registry.register('lcod://contract/tooling/resolver/resolve_dependencies@1', async (ctx, input = {}) => {
    const sanitizeStrings = (value) => Array.isArray(value)
      ? value.filter((msg) => typeof msg === 'string' && msg.length > 0)
      : [];
    const sanitizeObjectArray = (value) => Array.isArray(value)
      ? value.filter((entry) => entry && typeof entry === 'object')
      : [];
    const clonePlainObject = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return null;
      }
    };
    const hasKeys = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
    const callOptional = async (component, payload) => {
      try {
        return await ctx.call(component, payload ?? {});
      } catch (err) {
        if (process.env.LCOD_DEBUG_RESOLVER === '1') {
          console.error('[lcod-debug] resolver helper call failed', component, err);
        }
        return null;
      }
    };

    const rootDescriptor = input.rootDescriptor && typeof input.rootDescriptor === 'object'
      ? input.rootDescriptor
      : null;
    if (!rootDescriptor) {
      throw new Error('resolve_dependencies contract requires rootDescriptor');
    }
    let projectPath = typeof input.projectPath === 'string' && input.projectPath.length > 0
      ? path.resolve(input.projectPath)
      : process.cwd();
    let cacheRoot = typeof input.cacheRoot === 'string' && input.cacheRoot.length > 0
      ? path.resolve(input.cacheRoot)
      : projectPath;

    const baseWarnings = sanitizeStrings(input.warnings);
    const warningBuckets = [
      baseWarnings,
      sanitizeStrings(input.loadWarnings),
      sanitizeStrings(input.indexWarnings),
      sanitizeStrings(input.registrationWarnings),
      sanitizeStrings(input.pointerWarnings)
    ];
    let warnings = warningBuckets.flat();
    if (warningBuckets.some((bucket, idx) => idx > 0 && bucket.length > 0)) {
      const merged = await callOptional('lcod://tooling/resolver/warnings/merge@0.1.0', { buckets: warningBuckets });
      if (merged && Array.isArray(merged.warnings)) {
        warnings = merged.warnings.slice();
      }
    }

    const normalizedConfigRaw = clonePlainObject(input.normalizedConfig) ?? {};
    const configRaw = clonePlainObject(input.config) ?? {};
    const pointerRegistrySources = sanitizeObjectArray(input.pointerRegistrySources);
    const registryRegistries = Array.isArray(input.registryRegistries) ? input.registryRegistries : [];
    const registryEntries = Array.isArray(input.registryEntries) ? input.registryEntries : [];
    const registryPackages = input.registryPackages && typeof input.registryPackages === 'object'
      ? input.registryPackages
      : {};
    const sourcesPath = typeof input.sourcesPath === 'string' && input.sourcesPath.length > 0
      ? input.sourcesPath
      : null;

    let sources = hasKeys(normalizedConfigRaw.sources)
      ? normalizedConfigRaw.sources
      : (hasKeys(configRaw.sources) ? configRaw.sources : {});
    let registrySources = sanitizeObjectArray(input.registrySources);
    let replaceAlias = clonePlainObject(normalizedConfigRaw.replaceAlias) ?? {};
    let replaceSpec = clonePlainObject(normalizedConfigRaw.replaceSpec) ?? {};
    let allowlist = Array.isArray(normalizedConfigRaw.allowlist)
      ? normalizedConfigRaw.allowlist.filter((entry) => typeof entry === 'string' && entry.length > 0)
      : null;

    const normalizedForContext = clonePlainObject(normalizedConfigRaw) ?? {};
    if (pointerRegistrySources.length) {
      const existing = Array.isArray(normalizedForContext.registrySources)
        ? sanitizeObjectArray(normalizedForContext.registrySources)
        : [];
      normalizedForContext.registrySources = [...existing, ...pointerRegistrySources];
    }
    if (sourcesPath) {
      normalizedForContext.sourcesPath = sourcesPath;
    }

    const prepared = await callOptional('lcod://tooling/resolver/context/prepare@0.1.0', {
      projectPath,
      cacheRoot,
      normalizedConfig: normalizedForContext,
      warnings,
      registryWarnings: sanitizeStrings(input.indexWarnings)
    });
    if (prepared) {
      if (typeof prepared.projectPath === 'string' && prepared.projectPath.length > 0) {
        projectPath = path.resolve(prepared.projectPath);
      }
      if (typeof prepared.cacheRoot === 'string' && prepared.cacheRoot.length > 0) {
        cacheRoot = path.resolve(prepared.cacheRoot);
      }
      if (prepared.sources && typeof prepared.sources === 'object') {
        sources = prepared.sources;
      }
      if (Array.isArray(prepared.registrySources)) {
        registrySources = sanitizeObjectArray(prepared.registrySources);
      }
      if (prepared.replaceAlias && typeof prepared.replaceAlias === 'object') {
        replaceAlias = prepared.replaceAlias;
      }
      if (prepared.replaceSpec && typeof prepared.replaceSpec === 'object') {
        replaceSpec = prepared.replaceSpec;
      }
      if (Array.isArray(prepared.allowlist) || prepared.allowlist === null) {
        allowlist = prepared.allowlist;
      }
      if (Array.isArray(prepared.warnings)) {
        warnings = prepared.warnings.slice();
      }
    }

    const sourceEntries = extractSourceEntries(sources);
    if (!sourceEntries) {
      throw new Error('resolve_dependencies contract only supports object/array sources');
    }
    const sourceMap = new Map(sourceEntries.map(([key, spec]) => [key, spec]));
    const replaceAliasMap = new Map(Object.entries(replaceAlias));
    const replaceSpecMap = new Map(Object.entries(replaceSpec));
    const descriptorCache = new Map();
    const resolved = new Map();

    const hashTextValue = (text) => {
      const hash = createHash('sha256');
      hash.update(text, 'utf8');
      return `sha256-${hash.digest('hex')}`;
    };

    const normalizePath = (base, segment) => {
      if (!segment || segment === '.') return path.resolve(base);
      if (path.isAbsolute(segment)) return path.resolve(segment);
      if (segment.startsWith('~')) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        return path.resolve(home, segment.slice(1));
      }
      return path.resolve(base, segment);
    };

    const readDescriptor = async (descriptorPath) => {
      const normalized = path.resolve(descriptorPath);
      if (descriptorCache.has(normalized)) {
        return descriptorCache.get(normalized);
      }
      const text = await fsp.readFile(normalized, 'utf8');
      const descriptor = parseToml(text);
      const childIds = extractRequires(descriptor);
      const integrity = hashTextValue(text);
      const entry = { descriptor, descriptorText: text, childIds, integrity };
      descriptorCache.set(normalized, entry);
      return entry;
    };

    const isAllowed = (candidate) => {
      if (!allowlist || allowlist.length === 0) return true;
      return allowlist.some((rule) => {
        if (rule.endsWith('*')) {
          return candidate.startsWith(rule.slice(0, -1));
        }
        if (rule.endsWith('/')) {
          return candidate.startsWith(rule);
        }
        return candidate === rule || candidate.startsWith(`${rule}/`);
      });
    };

    const selectReplacement = async (id) => {
      const applied = await callOptional('lcod://tooling/resolver/replace/apply@0.1.0', {
        id,
        replaceAlias,
        replaceSpec
      });
      if (applied && typeof applied === 'object') {
        return {
          targetId: applied.targetId ?? id,
          override: applied.override ?? null,
          warnings: Array.isArray(applied.warnings) ? applied.warnings : []
        };
      }
      let current = id;
      let override = null;
      const visited = new Set();
      const localWarnings = [];
      while (true) {
        if (replaceSpecMap.has(current)) {
          override = replaceSpecMap.get(current);
          break;
        }
        if (!replaceAliasMap.has(current)) {
          break;
        }
        if (visited.has(current)) {
          localWarnings.push(`Replacement cycle detected: ${[...visited, current].join(' -> ')}`);
          break;
        }
        visited.add(current);
        current = replaceAliasMap.get(current);
      }
      return { targetId: current, override, warnings: localWarnings };
    };

    const gitClone = (payload) => ctx.call('lcod://contract/core/git/clone@1', payload);
    const httpDownload = (payload) => ctx.call('lcod://axiom/http/download@1', payload);
    const registrySelect = (payload) => ctx.call('lcod://tooling/registry/select@0.1.0', payload);

    const resolvePathSpec = async (spec, preload) => {
      const basePath = normalizePath(projectPath, spec.path || '.');
      if (preload && preload.descriptor && preload.descriptorText) {
        const integrity = hashTextValue(preload.descriptorText);
        const childIds = extractRequires(preload.descriptor);
        return {
          descriptor: preload.descriptor,
          descriptorText: preload.descriptorText,
          integrity,
          source: preload.source || { type: 'path', path: basePath },
          childIds
        };
      }
      const descriptor = await readDescriptor(path.join(basePath, 'lcp.toml'));
      return {
        ...descriptor,
        source: { type: 'path', path: basePath }
      };
    };

    const resolveGitSpec = async (id, spec) => {
      if (typeof spec.url !== 'string' || !spec.url) {
        throw new Error(`Missing git url for ${id}`);
      }
      const keyPayload = JSON.stringify({ id, url: spec.url, ref: spec.ref ?? null, subdir: spec.subdir ?? null });
      const keyHash = hashTextValue(keyPayload).replace('sha256-', '');
      const repoRoot = normalizePath(cacheRoot, 'git');
      const repoDir = normalizePath(repoRoot, keyHash);
      const descriptorRoot = spec.subdir ? normalizePath(repoDir, spec.subdir) : repoDir;
      const descriptorPath = path.join(descriptorRoot, 'lcp.toml');
      let data;
      let cloneMeta = null;
      try {
        data = await readDescriptor(descriptorPath);
      } catch (err) {
        const cloneInput = { url: spec.url, dest: repoDir };
        if (spec.ref) cloneInput.ref = spec.ref;
        if (spec.depth) cloneInput.depth = spec.depth;
        if (spec.subdir) cloneInput.subdir = spec.subdir;
        if (spec.auth) cloneInput.auth = spec.auth;
        cloneMeta = await gitClone(cloneInput);
        data = await readDescriptor(descriptorPath);
      }
      const source = {
        type: 'git',
        url: spec.url,
        path: descriptorRoot
      };
      if (spec.ref) source.ref = spec.ref;
      if (spec.subdir) source.subdir = spec.subdir;
      if (cloneMeta?.commit) source.commit = cloneMeta.commit;
      if (!source.ref && cloneMeta?.ref) source.ref = cloneMeta.ref;
      if (cloneMeta?.source?.fetchedAt) source.fetchedAt = cloneMeta.source.fetchedAt;
      return {
        descriptor: data.descriptor,
        descriptorText: data.descriptorText,
        integrity: data.integrity,
        source,
        childIds: data.childIds
      };
    };

    const resolveHttpSpec = async (id, spec) => {
      if (typeof spec.url !== 'string' || !spec.url) {
        throw new Error(`Missing http url for ${id}`);
      }
      const keyPayload = JSON.stringify({ id, url: spec.url, descriptorPath: spec.descriptorPath ?? null });
      const keyHash = hashTextValue(keyPayload).replace('sha256-', '');
      const httpRoot = normalizePath(cacheRoot, 'http');
      const artifactDir = normalizePath(httpRoot, keyHash);
      const filename = typeof spec.filename === 'string' && spec.filename ? spec.filename : 'artifact.toml';
      const artifactPath = normalizePath(artifactDir, filename);
      const descriptorPath = spec.descriptorPath
        ? normalizePath(artifactDir, spec.descriptorPath)
        : artifactPath;
      let data;
      try {
        data = await readDescriptor(descriptorPath);
      } catch (err) {
        const downloadInput = { url: spec.url, path: artifactPath };
        if (spec.method) downloadInput.method = spec.method;
        if (spec.headers) downloadInput.headers = spec.headers;
        if (spec.query) downloadInput.query = spec.query;
        if (spec.timeoutMs) downloadInput.timeoutMs = spec.timeoutMs;
        if (spec.followRedirects !== undefined) downloadInput.followRedirects = spec.followRedirects;
        if (spec.body !== undefined) downloadInput.body = spec.body;
        if (spec.bodyEncoding) downloadInput.bodyEncoding = spec.bodyEncoding;
        await httpDownload(downloadInput);
        data = await readDescriptor(descriptorPath);
      }
      const source = {
        type: 'http',
        url: spec.url,
        path: spec.descriptorPath ? artifactDir : descriptorPath
      };
      if (spec.descriptorPath) source.descriptorPath = spec.descriptorPath;
      if (spec.filename) source.filename = filename;
      return {
        descriptor: data.descriptor,
        descriptorText: data.descriptorText,
        integrity: data.integrity,
        source,
        childIds: data.childIds
      };
    };

    const resolveRegistrySpec = async () => ({
      descriptor: {},
      descriptorText: '',
      source: { type: 'registry' },
      childIds: []
    });

    const loadSpec = async (id, spec, preload) => {
      if (spec?.type === 'path') return resolvePathSpec(spec, preload);
      if (spec?.type === 'git') return resolveGitSpec(id, spec);
      if (spec?.type === 'http') return resolveHttpSpec(id, spec);
      if (spec?.type === 'registry') return resolveRegistrySpec(id, spec);
      if (preload && preload.descriptor && preload.descriptorText) {
        const integrity = hashTextValue(preload.descriptorText);
        const childIds = extractRequires(preload.descriptor);
        return {
          descriptor: preload.descriptor,
          descriptorText: preload.descriptorText,
          integrity,
          source: preload.source || { type: 'path', path: projectPath },
          childIds
        };
      }
      return {
        descriptor: {},
        descriptorText: '',
        source: { type: 'registry', reference: id },
        childIds: []
      };
    };

    const parseComponentId = (identifier) => {
      if (typeof identifier !== 'string') {
        return { base: identifier, version: null };
      }
      const atIndex = identifier.lastIndexOf('@');
      if (atIndex <= 'lcod://'.length) {
        return { base: identifier, version: null };
      }
      return {
        base: identifier.slice(0, atIndex),
        version: identifier.slice(atIndex + 1)
      };
    };

    const ensureVersionId = (baseId, version) => {
      if (!version) return baseId;
      return `${baseId}@${version}`;
    };

    const resolveDependency = async (depId, stack = [], preload) => {
      const originalId = typeof depId === 'string' && depId ? depId : String(depId);
      if (resolved.has(originalId)) return resolved.get(originalId);
      if (!isAllowed(originalId)) {
        throw new Error(`Dependency ${originalId} is not allowed by resolver configuration`);
      }
      if (stack.includes(originalId)) {
        throw new Error(`Dependency cycle detected: ${[...stack, originalId].join(' -> ')}`);
      }
      const { targetId: replacementId, override, warnings: replacementWarnings } = await selectReplacement(originalId);
      if (replacementWarnings && replacementWarnings.length) {
        warnings.push(...replacementWarnings);
      }
      const targetIdInitial = replacementId ?? originalId;
      if (!isAllowed(targetIdInitial)) {
        throw new Error(`Dependency ${targetIdInitial} is not allowed by resolver configuration`);
      }
      let spec = override
        ?? (preload && originalId === targetIdInitial ? preload.source : undefined)
        ?? sourceMap.get(targetIdInitial)
        ?? sourceMap.get(originalId);
      let targetId = targetIdInitial;

      const parsedTarget = parseComponentId(targetIdInitial);
      const baseTargetId = parsedTarget.base;
      let versionHint = parsedTarget.version;
      if (spec && typeof spec.version === 'string' && spec.version.length > 0) {
        versionHint = spec.version;
      }
      const registryHint = spec && typeof spec.registryId === 'string' && spec.registryId.length > 0
        ? spec.registryId
        : undefined;

      if (!spec || spec.type === 'registry' || !spec.type) {
        const request = {
          packages: registryPackages,
          id: baseTargetId,
          range: versionHint,
          registryId: registryHint
        };
        try {
          const selection = await registrySelect(request);
          const registryEntry = selection?.entry || null;
          if (registryEntry) {
            targetId = ensureVersionId(baseTargetId, registryEntry.version || versionHint);
            spec = {
              type: 'registry',
              registryId: registryEntry.registryId,
              entry: registryEntry
            };
          }
        } catch (err) {
          warnings.push(`Registry lookup error for ${originalId}: ${err.message}`);
        }
      }

      let info;
      try {
        const preloadCandidate = originalId === targetId ? preload : undefined;
        info = await loadSpec(targetId, spec, preloadCandidate);
      } catch (err) {
        warnings.push(`Failed to load ${targetId} for ${originalId}: ${err.message}`);
        const fallbackSource = spec && spec.type ? spec.type : 'registry';
        const fallback = {
          id: originalId,
          resolved: targetId !== originalId ? targetId : undefined,
          source: { type: fallbackSource, reference: targetId },
          dependencies: []
        };
        resolved.set(originalId, fallback);
        return fallback;
      }

      let source = info?.source || { type: 'registry', reference: targetId };
      if ((!source || source.type === 'registry') && spec && typeof spec === 'object') {
        if (spec.type === 'path') {
          const basePath = normalizePath(projectPath, spec.path || '.');
          source = { type: 'path', path: basePath };
        } else if (spec.type === 'git' && typeof spec.url === 'string' && spec.url) {
          source = info?.source || { type: 'git', url: spec.url };
        } else if (spec.type === 'http' && typeof spec.url === 'string' && spec.url) {
          source = info?.source || { type: 'http', url: spec.url };
          if (!source.descriptorPath && spec.descriptorPath) {
            source.descriptorPath = spec.descriptorPath;
          }
        }
      }

      const record = {
        id: originalId,
        source,
        dependencies: []
      };
      if (targetId !== originalId) {
        record.resolved = targetId;
      }
      if (info?.integrity) record.integrity = info.integrity;
      resolved.set(originalId, record);

      const childIds = Array.isArray(info?.childIds) ? info.childIds : [];
      for (const child of childIds) {
        if (typeof child !== 'string' || !child) continue;
        try {
          const childRecord = await resolveDependency(child, [...stack, originalId]);
          if (childRecord) record.dependencies.push(childRecord);
        } catch (err) {
          warnings.push(`Failed to resolve ${child} for ${originalId}: ${err.message}`);
        }
      }
      return record;
    };

    const rootId = typeof input.rootId === 'string' && input.rootId.length > 0
      ? input.rootId
      : rootDescriptor.id;
    if (!rootId) {
      throw new Error('rootId missing');
    }
    const preloadRoot = {
      descriptor: rootDescriptor,
      descriptorText: typeof input.rootDescriptorText === 'string' ? input.rootDescriptorText : '',
      source: { type: 'path', path: projectPath }
    };
    const rootRecord = await resolveDependency(rootId, [], preloadRoot);
    const resolverResult = {
      root: rootRecord,
      warnings: warnings.slice(),
      registry: {
        registries: registryRegistries,
        entries: registryEntries,
        packages: registryPackages
      }
    };
    return {
      resolverResult,
      warnings
    };
  });
}

function extractSourceEntries(sources) {
  if (!sources) return [];
  if (Array.isArray(sources)) {
    return sources
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = typeof entry.id === 'string' && entry.id.length > 0
          ? entry.id
          : (typeof entry.target === 'string' ? entry.target : null);
        if (!id) return null;
        const spec = entry.spec && typeof entry.spec === 'object' ? entry.spec : entry;
        return [id, spec];
      })
      .filter(Boolean);
  }
  if (typeof sources === 'object') {
    return Object.entries(sources).filter(([key]) => typeof key === 'string' && key.length > 0);
  }
  return null;
}

function isPathSpec(spec) {
  return spec && typeof spec === 'object' && (!spec.type || spec.type === 'path') && typeof spec.path === 'string';
}

function extractRequires(descriptor) {
  const requires = descriptor?.deps?.requires;
  if (!Array.isArray(requires)) return [];
  return requires.filter((dep) => typeof dep === 'string' && dep.length > 0);
}

function hashText(text) {
  const hash = createHash('sha256');
  hash.update(text, 'utf8');
  return `sha256-${hash.digest('hex')}`;
}
