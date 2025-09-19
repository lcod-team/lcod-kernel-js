#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import TOML from '@iarna/toml';

function usage() {
  console.error('Usage: node scripts/resolve.mjs --project path/to/project [--config resolve.config.json] [--output lcp.lock]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { project: process.cwd(), config: null, output: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' || a === '-p') args.project = argv[++i];
    else if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--output' || a === '-o') args.output = argv[++i];
    else usage();
  }
  return args;
}

function loadConfig(file) {
  if (!file) return { sources: {} };
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

const args = parseArgs(process.argv);
const projectDir = path.resolve(process.cwd(), args.project);
const descriptorPath = path.join(projectDir, 'lcp.toml');
if (!fs.existsSync(descriptorPath)) {
  console.error(`Cannot find lcp.toml in ${projectDir}`);
  process.exit(1);
}

const configPath = args.config ? path.resolve(process.cwd(), args.config) : path.join(projectDir, 'resolve.config.json');
let config = { sources: {}, replace: {}, bindings: {} };
if (fs.existsSync(configPath)) {
  config = loadConfig(configPath);
} else if (args.config) {
  console.error(`Cannot find config file ${configPath}`);
  process.exit(1);
}

const lcp = TOML.parse(fs.readFileSync(descriptorPath, 'utf8'));
const deps = Array.isArray(lcp?.deps?.requires) ? lcp.deps.requires : [];

const warnings = [];

const lock = {
  schemaVersion: '1.0',
  resolverVersion: '0.1.0',
  components: []
};

const rootComponent = {
  id: lcp.id,
  resolved: lcp.id,
  source: { type: 'path', path: '.' }
};
if (config.bindings && Object.keys(config.bindings).length) {
  rootComponent.bindings = Object.entries(config.bindings).map(([contract, implementation]) => ({ contract, implementation }));
}
if (deps.length) {
  rootComponent.dependencies = deps.map(dep => ({
    id: dep,
    requested: dep,
    resolved: (config.replace || {})[dep] || dep
  }));
}
lock.components.push(rootComponent);

function hashFile(file) {
  try {
    const buf = fs.readFileSync(file);
    const digest = crypto.createHash('sha256').update(buf).digest('base64');
    return `sha256-${digest}`;
  } catch (err) {
    warnings.push(`Failed to hash ${file}: ${err.message}`);
    return undefined;
  }
}

const sources = config.sources || {};

for (const dep of deps) {
  const target = (config.replace || {})[dep] || dep;
  const mapping = sources[target];
  if (!mapping) {
    warnings.push(`No source mapping for ${dep}`);
    continue;
  }
  const entry = {
    id: dep,
    resolved: mapping.resolved || target,
    source: { ...mapping }
  };
  if (mapping.type === 'path' && mapping.path) {
    const abs = path.resolve(projectDir, mapping.path);
    entry.source.path = path.relative(projectDir, abs) || '.';
    const descriptor = path.join(abs, 'lcp.toml');
    if (fs.existsSync(descriptor)) {
      entry.integrity = hashFile(descriptor);
    } else {
      warnings.push(`Descriptor not found for ${dep} at ${descriptor}`);
    }
  }
  lock.components.push(entry);
}

const outPath = args.output
  ? path.resolve(process.cwd(), args.output)
  : path.join(projectDir, 'lcp.lock');
fs.writeFileSync(outPath, TOML.stringify(lock));
warnings.forEach(msg => console.warn(`WARN: ${msg}`));
console.log(`Lockfile written to ${outPath}`);
