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
    const projectPath = typeof input.projectPath === 'string' ? input.projectPath : null;
    const normalizedConfig = input.normalizedConfig && typeof input.normalizedConfig === 'object'
      ? input.normalizedConfig
      : null;
    const rootDescriptor = input.rootDescriptor && typeof input.rootDescriptor === 'object'
      ? input.rootDescriptor
      : null;
    if (!projectPath || !normalizedConfig || !rootDescriptor) {
      throw new Error('resolve_dependencies contract requires projectPath, normalizedConfig and rootDescriptor');
    }

    const initialWarnings = Array.isArray(input.warnings)
      ? input.warnings.filter((msg) => typeof msg === 'string' && msg.length > 0)
      : [];
    const warnings = [...initialWarnings];
    const sourceEntries = extractSourceEntries(normalizedConfig.sources);
    if (!sourceEntries) {
      throw new Error('resolve_dependencies contract only supports object/array sources');
    }
    if (sourceEntries.some(([, spec]) => !isPathSpec(spec))) {
      throw new Error('resolve_dependencies contract currently supports path sources only');
    }
    const sourceMap = new Map(sourceEntries.map(([key, spec]) => [key, spec]));
    const descriptorCache = new Map();
    const resolved = new Map();

    const readDescriptor = async (basePath, preload) => {
      if (preload && preload.descriptor && preload.descriptorText) {
        const childIds = extractRequires(preload.descriptor);
        const integrity = hashText(preload.descriptorText);
        return {
          descriptor: preload.descriptor,
          descriptorText: preload.descriptorText,
          childIds,
          integrity
        };
      }
      const descriptorPath = path.join(basePath, 'lcp.toml');
      const cacheKey = descriptorPath;
      if (descriptorCache.has(cacheKey)) {
        return descriptorCache.get(cacheKey);
      }
      let text;
      try {
        text = await fsp.readFile(descriptorPath, 'utf8');
      } catch (err) {
        throw new Error(`Failed to read descriptor ${descriptorPath}: ${err.message || err}`);
      }
      let parsed;
      try {
        parsed = parseToml(text);
      } catch (err) {
        throw new Error(`Failed to parse descriptor ${descriptorPath}: ${err.message || err}`);
      }
      const entry = {
        descriptor: parsed,
        descriptorText: text,
        childIds: extractRequires(parsed),
        integrity: hashText(text)
      };
      descriptorCache.set(cacheKey, entry);
      return entry;
    };

    const resolveDependency = async (depId, stack = [], preload) => {
      const targetId = typeof depId === 'string' && depId.length > 0 ? depId : String(depId);
      if (resolved.has(targetId)) return resolved.get(targetId);
      if (stack.includes(targetId)) {
        throw new Error(`Dependency cycle detected: ${[...stack, targetId].join(' -> ')}`);
      }
      let spec = sourceMap.get(targetId);
      if (!spec) {
        if (preload && preload.source && preload.source.type === 'path') {
          spec = { type: 'path', path: preload.source.path };
        }
      }
      if (!spec || !isPathSpec(spec)) {
        throw new Error(`Unsupported spec for ${targetId}`);
      }
      const basePath = path.isAbsolute(spec.path)
        ? spec.path
        : path.join(projectPath, spec.path === '.' ? '' : spec.path);
      const descriptorData = await readDescriptor(basePath, preload);
      const record = {
        id: targetId,
        source: { type: 'path', path: basePath },
        dependencies: []
      };
      if (descriptorData.integrity) {
        record.integrity = descriptorData.integrity;
      }
      resolved.set(targetId, record);
      for (const childId of descriptorData.childIds) {
        try {
          const child = await resolveDependency(childId, [...stack, targetId]);
          record.dependencies.push(child);
        } catch (err) {
          warnings.push(`Failed to resolve ${childId} for ${targetId}: ${err.message || err}`);
        }
      }
      return record;
    };

    const preloadRoot = {
      descriptor: rootDescriptor,
      descriptorText: typeof input.rootDescriptorText === 'string' ? input.rootDescriptorText : '',
      source: { type: 'path', path: projectPath }
    };

    const rootId = typeof input.rootId === 'string' && input.rootId.length > 0
      ? input.rootId
      : rootDescriptor.id;
    if (!rootId) {
      throw new Error('rootId missing');
    }

    const rootRecord = await resolveDependency(rootId, [], preloadRoot);

    if (process.env.LCOD_DEBUG_RESOLVER === '1') {
      console.error('[lcod-debug] resolve_dependencies contract success');
    }
    const resolverResult = {
      root: rootRecord,
      warnings: warnings.slice(),
      registry: {
        registries: Array.isArray(input.registryRegistries) ? input.registryRegistries : [],
        entries: Array.isArray(input.registryEntries) ? input.registryEntries : [],
        packages: input.registryPackages && typeof input.registryPackages === 'object'
          ? input.registryPackages
          : {}
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
