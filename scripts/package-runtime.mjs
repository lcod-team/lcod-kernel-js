#!/usr/bin/env node
/**
 * Generate the LCOD runtime bundle alongside the Node kernel.
 *
 * Delegates to lcod-spec/scripts/package-runtime.mjs after ensuring the
 * resolver runtime snapshot is fresh. Use this script in release builds so
 * published artefacts embed the latest helper components (including tooling/fs).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const specRoot = await resolveRepo('SPEC_REPO_PATH', options.spec ?? '../lcod-spec');
  const resolverRoot = await resolveRepo(
    'LCOD_RESOLVER_PATH',
    options.resolver ?? '../lcod-resolver'
  );

  if (!options.skipResolverExport) {
    run('node', ['scripts/export-runtime.mjs'], { cwd: resolverRoot, stdio: 'inherit' });
  }

  const outputDir = path.resolve(
    repoRoot,
    options.output ?? path.join('dist', 'runtime')
  );
  if (!options.dryRun) {
    await fs.mkdir(outputDir, { recursive: true });
  }
  const label =
    options.label ??
    (process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : 'dev');

  const env = {
    ...process.env,
    RESOLVER_REPO_PATH: resolverRoot,
  };
  const args = [
    'scripts/package-runtime.mjs',
    '--output',
    outputDir,
    '--label',
    label,
  ];
  if (options.keep) args.push('--keep');
  if (options.dryRun) args.push('--dry-run');

  run('node', args, { cwd: specRoot, env, stdio: 'inherit' });
  const archive = path.join(outputDir, `lcod-runtime-${label}.tar.gz`);
  console.log(`Runtime bundle ready: ${archive}`);
}

async function resolveRepo(envKey, fallback) {
  const candidates = [];
  if (process.env[envKey]) {
    candidates.push(process.env[envKey]);
  }
  candidates.push(path.resolve(repoRoot, fallback));
  candidates.push(path.resolve(process.cwd(), fallback));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return path.resolve(candidate);
    } catch {}
  }
  throw new Error(
    `Unable to locate repository for ${envKey}. Set the variable or pass --spec/--resolver.`
  );
}

function run(cmd, args, options) {
  execFileSync(cmd, args, options);
}

function parseArgs(argv) {
  const opts = {
    keep: false,
    dryRun: false,
    skipResolverExport: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--spec':
        opts.spec = argv[++i];
        break;
      case '--resolver':
        opts.resolver = argv[++i];
        break;
      case '--output':
        opts.output = argv[++i];
        break;
      case '--label':
        opts.label = argv[++i];
        break;
      case '--keep':
        opts.keep = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--skip-resolver-export':
        opts.skipResolverExport = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: npm run bundle:runtime -- [options]

Options:
  --spec <path>               Path to lcod-spec (default: ../lcod-spec)
  --resolver <path>           Path to lcod-resolver (default: ../lcod-resolver)
  --output <dir>              Output directory (default: dist/runtime)
  --label <name>              Bundle label (default: dev or GITHUB_SHA prefix)
  --keep                      Keep staging directory created by lcod-spec script
  --dry-run                   Validate configuration without writing files
  --skip-resolver-export      Assume resolver snapshot is already up to date
  -h, --help                  Show this message`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
