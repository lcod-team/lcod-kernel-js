#!/usr/bin/env node
/**
 * Build distributable CLI archives for the Node kernel.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tar from 'tar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const PLATFORMS = [
  'linux-x86_64',
  'linux-arm64',
  'macos-x86_64',
  'macos-arm64',
  'windows-x86_64'
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const label = options.label ?? deriveLabel();
  const runtimeArchive = await resolveRuntimeArchive(options.runtime, label, options.output);
  const outputDir = path.resolve(repoRoot, options.output ?? path.join('dist', 'cli'));
  await fs.mkdir(outputDir, { recursive: true });

  for (const platform of PLATFORMS) {
    await buildBundle({ label, platform, runtimeArchive, outputDir });
  }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--label':
        opts.label = argv[++i];
        break;
      case '--runtime':
        opts.runtime = argv[++i];
        break;
      case '--output':
        opts.output = argv[++i];
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/package-cli.mjs [options]

Options:
  --label <value>      Version label (default: package.json version)
  --runtime <path>     Path to lcod-runtime-<label>.tar.gz (default: dist/runtime)
  --output <dir>       Output directory for CLI bundles (default: dist/cli)
`);
}

function deriveLabel() {
  const pkg = JSON.parse(execFileSync('node', ['-e', 'console.log(require("./package.json").version)'], { cwd: repoRoot, encoding: 'utf8' }));
  if (!pkg || typeof pkg !== 'string') {
    throw new Error('Unable to determine version label from package.json');
  }
  return pkg;
}

async function resolveRuntimeArchive(provided, label, outputDir) {
  if (provided) {
    const resolved = path.resolve(repoRoot, provided);
    await fs.access(resolved);
    return resolved;
  }
  const defaultPath = path.resolve(repoRoot, outputDir ?? path.join('dist', 'runtime'), `lcod-runtime-${label}.tar.gz`);
  await fs.access(defaultPath);
  return defaultPath;
}

async function buildBundle({ label, platform, runtimeArchive, outputDir }) {
  const stagingRoot = await fs.mkdtemp(path.join(outputDir, `${platform}-stage-`));
  const bundleRoot = path.join(stagingRoot, 'bundle');
  await fs.mkdir(bundleRoot, { recursive: true });

  const runtimeDir = path.join(bundleRoot, 'runtime');
  await extractRuntime(runtimeArchive, runtimeDir);

  await copyKernelSources(bundleRoot);
  await copyNodeModules(bundleRoot);
  await writePackageManifest(bundleRoot, label);
  await writeLaunchScripts(bundleRoot);

  const archiveName = `lcod-run-${label}-${platform}.${platform.startsWith('windows-') ? 'zip' : 'tar.gz'}`;
  const archivePath = path.join(outputDir, archiveName);

  await fs.rm(archivePath, { force: true });
  if (platform.startsWith('windows-')) {
    execFileSync('zip', ['-rq', archivePath, '.'], {
      cwd: bundleRoot,
      stdio: 'inherit'
    });
  } else {
    const entries = await fs.readdir(bundleRoot);
    await tar.create(
      {
        gzip: true,
        cwd: bundleRoot,
        file: archivePath
      },
      entries
    );
  }

  await fs.rm(stagingRoot, { recursive: true, force: true });
}

async function extractRuntime(archivePath, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  await tar.extract({
    file: archivePath,
    cwd: targetDir,
    strip: 1
  });
}

async function copyKernelSources(bundleRoot) {
  const targets = [
    { from: 'src', to: path.join(bundleRoot, 'src') },
    { from: 'bin/run-compose.mjs', to: path.join(bundleRoot, 'bin', 'run-compose.mjs') },
    { from: 'bin/lcod-run.mjs', to: path.join(bundleRoot, 'bin', 'lcod-run.mjs') },
    { from: 'resources', to: path.join(bundleRoot, 'resources') },
    { from: 'demo.modules.json', to: path.join(bundleRoot, 'demo.modules.json') },
    { from: 'bindings.demo.json', to: path.join(bundleRoot, 'bindings.demo.json') }
  ];
  for (const entry of targets) {
    const source = path.join(repoRoot, entry.from);
    const destination = entry.to;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true });
  }
}

async function copyNodeModules(bundleRoot) {
  const source = path.join(repoRoot, 'node_modules');
  const destination = path.join(bundleRoot, 'node_modules');
  await fs.cp(source, destination, { recursive: true });
}

async function writePackageManifest(bundleRoot, label) {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const manifest = {
    name: 'lcod-run-node',
    version: label,
    type: 'module',
    description: 'LCOD Node kernel bundle',
    license: pkg.license ?? 'MIT'
  };
  await fs.writeFile(path.join(bundleRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function writeLaunchScripts(bundleRoot) {
  const scriptPath = path.join(bundleRoot, 'lcod-run');
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'if [[ -z "${LCOD_HOME:-}" ]]; then',
    '  export LCOD_HOME="$ROOT/runtime"',
    'fi',
    'if [[ -z "${SPEC_REPO_PATH:-}" ]]; then',
    '  export SPEC_REPO_PATH="$ROOT/runtime"',
    'fi',
    'if [[ -z "${LCOD_SPEC_PATH:-}" ]]; then',
    '  export LCOD_SPEC_PATH="$ROOT/runtime"',
    'fi',
    'exec "${NODE:-node}" "$ROOT/bin/lcod-run.mjs" "$@"'
  ];
  await fs.writeFile(scriptPath, lines.join('\n') + '\n', { mode: 0o755 });
  await fs.chmod(scriptPath, 0o755);

  const cmdPath = path.join(bundleRoot, 'lcod-run.cmd');
  const cmdLines = [
    '@echo off',
    'setlocal',
    'set ROOT=%~dp0',
    'if "%ROOT:~-1%"=="\\" set ROOT=%ROOT:~0,-1%',
    'if "%LCOD_HOME%"=="" set LCOD_HOME=%ROOT%\\runtime',
    'if "%SPEC_REPO_PATH%"=="" set SPEC_REPO_PATH=%ROOT%\\runtime',
    'if "%LCOD_SPEC_PATH%"=="" set LCOD_SPEC_PATH=%ROOT%\\runtime',
    'set NODE_EXEC=%NODE%',
    'if "%NODE_EXEC%"=="" set NODE_EXEC=node',
    '"%NODE_EXEC%" "%ROOT%\\bin\\lcod-run.mjs" %*'
  ];
  await fs.writeFile(cmdPath, cmdLines.join('\r\n') + '\r\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
