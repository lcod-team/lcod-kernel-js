import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CANDIDATES = (() => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const list = [];
  if (process.env.LCOD_RESOLVER_COMPOSE) {
    list.push(path.resolve(process.env.LCOD_RESOLVER_COMPOSE));
  }
  list.push(
    path.resolve(repoRoot, '..', 'lcod-resolver', 'compose.yaml'),
    path.resolve(repoRoot, 'resources', 'compose', 'resolver', 'compose.yaml')
  );
  return list;
})();

export async function resolveResolverComposePath() {
  for (const candidate of CANDIDATES) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  throw new Error(
    `Unable to locate resolver compose.yaml. Checked: ${CANDIDATES.join(', ')}`
  );
}
