import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function buildCandidates() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const list = [];
  if (process.env.LCOD_RESOLVER_COMPOSE) {
    list.push(path.resolve(process.env.LCOD_RESOLVER_COMPOSE));
  }
  if (process.env.LCOD_RESOLVER_PATH) {
    list.push(
      path.resolve(
        process.env.LCOD_RESOLVER_PATH,
        'packages',
        'resolver',
        'compose.yaml'
      )
    );
    list.push(
      path.resolve(
        process.env.LCOD_RESOLVER_PATH,
        'compose.yaml'
      )
    );
  }
  const pushWorkspacePaths = (envVar) => {
    const value = process.env[envVar];
    if (!value) return;
    for (const entry of value.split(path.delimiter).map((item) => item.trim()).filter(Boolean)) {
      list.push(path.resolve(entry, 'packages', 'resolver', 'compose.yaml'));
      list.push(path.resolve(entry, 'compose.yaml'));
    }
  };
  pushWorkspacePaths('LCOD_WORKSPACE_PATHS');
  pushWorkspacePaths('LCOD_COMPONENTS_PATHS');
  if (process.env.SPEC_REPO_PATH) {
    list.push(
      path.resolve(
        process.env.SPEC_REPO_PATH,
        'resources',
        'compose',
        'resolver',
        'compose.yaml'
      )
    );
  }
  if (process.env.LCOD_SPEC_PATH) {
    list.push(
      path.resolve(
        process.env.LCOD_SPEC_PATH,
        'resources',
        'compose',
        'resolver',
        'compose.yaml'
      )
    );
  }
  list.push(
    path.resolve(repoRoot, '..', 'lcod-resolver', 'packages', 'resolver', 'compose.yaml'),
    path.resolve(repoRoot, '..', 'lcod-resolver', 'compose.yaml'),
    path.resolve(repoRoot, '..', 'lcod-spec', 'resources', 'compose', 'resolver', 'compose.yaml')
  );
  return list;
}

export async function resolveResolverComposePath({ required = true } = {}) {
  const candidates = buildCandidates();
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  if (!required) {
    return null;
  }
  throw new Error(
    `Unable to locate resolver compose.yaml. Checked: ${candidates.join(', ')}`
  );
}
