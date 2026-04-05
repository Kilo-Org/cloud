/**
 * Copy the root pnpm-workspace.yaml (catalog only) and pnpm-lock.yaml
 * into the container build context so pnpm can resolve catalog: references.
 *
 * The packages: section and other non-catalog sections are stripped because
 * those workspace paths don't exist inside the container and would cause
 * pnpm to error on workspace: references.
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gastownRoot = resolve(__dirname, '..');
const repoRoot = resolve(gastownRoot, '..');
const containerDir = resolve(gastownRoot, 'container');

// Read root workspace yaml and extract only the catalog: section.
// Parse line-by-line: keep lines from `catalog:` until the next
// top-level key (a line starting with a non-space, non-comment char).
const lines = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8').split('\n');
const catalogLines = [];
let inCatalog = false;

for (const line of lines) {
  if (line.startsWith('catalog:')) {
    inCatalog = true;
    catalogLines.push(line);
    continue;
  }
  if (inCatalog) {
    // Still in catalog if line is indented, empty, or a comment
    if (line === '' || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#')) {
      catalogLines.push(line);
    } else {
      break;
    }
  }
}

writeFileSync(resolve(containerDir, 'pnpm-workspace.yaml'), catalogLines.join('\n') + '\n');

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
  'Prepared container build context with pnpm-workspace.yaml (catalog only) and pnpm-lock.yaml'
);
