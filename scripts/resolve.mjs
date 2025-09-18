#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
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
let config = { sources: {} };
if (fs.existsSync(configPath)) {
  config = loadConfig(configPath);
} else if (args.config) {
  console.error(`Cannot find config file ${configPath}`);
  process.exit(1);
}

const lcp = TOML.parse(fs.readFileSync(descriptorPath, 'utf8'));
const deps = Array.isArray(lcp?.deps?.requires) ? lcp.deps.requires : [];

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
if (deps.length) {
  rootComponent.dependencies = deps.map(dep => ({ id: dep, requested: dep }));
}
lock.components.push(rootComponent);

for (const dep of deps) {
  const source = (config.sources || {})[dep];
  if (!source) {
    console.warn(`WARN: no source mapping for ${dep}`);
    continue;
  }
  lock.components.push({ id: dep, resolved: dep, source });
}

const outPath = args.output
  ? path.resolve(process.cwd(), args.output)
  : path.join(projectDir, 'lcp.lock');
fs.writeFileSync(outPath, TOML.stringify(lock));
console.log(`Lockfile written to ${outPath}`);

