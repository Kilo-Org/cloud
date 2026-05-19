/**
 * Copy the root pnpm-workspace.yaml (with `packages:` and
 * `patchedDependencies:` stripped) and pnpm-lock.yaml into the container
 * build context so pnpm can resolve catalog: references and honour the
 * same overrides / allowBuilds policy as the monorepo root.
 *
 * Stripped sections:
 *   - `packages:` — workspace paths don't exist inside the container and
 *     would cause pnpm to error on workspace: references.
 *   - `patchedDependencies:` — patch files live under repoRoot/patches/
 *     and aren't copied into the container; pnpm would fail to find them.
 *
 * Sections kept (notably):
 *   - `catalog:` — required to resolve `catalog:` deps in package.prod.json.
 *   - `overrides:` — the lockfile bakes resolved versions in, but pnpm
 *     validates that workspace overrides match what's pinned. Dropping
 *     this triggers ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
 *   - `allowBuilds:` — required for transitive native-build deps such as
 *     msgpackr-extract; without it, pnpm 11 exits with
 *     ERR_PNPM_IGNORED_BUILDS in non-interactive mode.
 *   - `publicHoistPattern`, `autoInstallPeers`, `minimumReleaseAge*` —
 *     keep pnpm behaviour aligned with the root install.
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gastownRoot = resolve(__dirname, '..');
const repoRoot = resolve(gastownRoot, '..', '..');
const containerDir = resolve(gastownRoot, 'container');

// Read root workspace yaml and drop the top-level sections that don't
// make sense (or actively break) inside the container build context.
// Parse line-by-line: a top-level key is a line whose first character is
// non-whitespace and not `#`. Once we see a key in DROP_TOP_KEYS, skip
// all of its (indented/blank/comment) child lines until the next
// top-level key or EOF.
const DROP_TOP_KEYS = new Set(['packages', 'patchedDependencies']);

const lines = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8').split('\n');
const kept = [];
let dropping = false;

const isTopLevelKey = line =>
  line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('#');

for (const line of lines) {
  if (isTopLevelKey(line)) {
    const key = line.split(':', 1)[0];
    dropping = DROP_TOP_KEYS.has(key);
    if (!dropping) kept.push(line);
    continue;
  }
  if (!dropping) kept.push(line);
}

writeFileSync(resolve(containerDir, 'pnpm-workspace.yaml'), kept.join('\n'));

// Create a production-only package.json that strips workspace: references
// (they can't be resolved outside the monorepo).
const pkg = JSON.parse(readFileSync(resolve(containerDir, 'package.json'), 'utf8'));
for (const depKey of ['dependencies', 'devDependencies']) {
  if (pkg[depKey]) {
    for (const [name, version] of Object.entries(pkg[depKey])) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        delete pkg[depKey][name];
      }
    }
  }
}
writeFileSync(resolve(containerDir, 'package.prod.json'), JSON.stringify(pkg, null, 2) + '\n');

// Copy the lockfile as-is
copyFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), resolve(containerDir, 'pnpm-lock.yaml'));

console.log(
  'Prepared container build context with pnpm-workspace.yaml (packages/patchedDependencies stripped) and pnpm-lock.yaml'
);
