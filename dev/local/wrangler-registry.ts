import * as path from 'node:path';

export function getWranglerRegistryPath(repoRoot: string): string {
  return path.resolve(repoRoot, '.wrangler', 'dev-registry');
}
