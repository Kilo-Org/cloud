#!/usr/bin/env node
// Print `key=<sha256>` for the inputs of the @kilocode/trpc declaration build.
//
// The key covers every file the declaration program reads that lives in the
// repository (from `tsgo --listFilesOnly`), the build configuration, and
// pnpm-lock.yaml. Files under node_modules are pinned by the lockfile, so they
// are left out of the per-file hash. Any failure exits non-zero: a key that
// misses an input would restore stale declarations.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = process.cwd();
const trpc = resolve(root, 'packages/trpc');
const listed = execFileSync(
  resolve(root, 'node_modules/.bin/tsgo'),
  ['-p', 'tsconfig.json', '--listFilesOnly'],
  { cwd: trpc, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);
if (listed.length === 0) throw new Error('tsgo listed no files for packages/trpc');

const files = new Set([
  'pnpm-lock.yaml',
  'packages/trpc/package.json',
  'packages/trpc/tsconfig.json',
  'packages/trpc/rollup.config.mjs',
  // The action holds the build command, and this script decides the inputs:
  // a change to either must not reuse declarations built the old way.
  '.github/actions/trpc-declarations/action.yml',
  'scripts/trpc-declaration-key.mjs',
]);
for (const file of listed) {
  const path = relative(root, resolve(trpc, file));
  if (path.startsWith('..') || path.split('/').includes('node_modules')) continue;
  files.add(path);
}

const hash = createHash('sha256');
for (const path of [...files].sort()) {
  hash
    .update(path)
    .update('\0')
    .update(readFileSync(resolve(root, path)))
    .update('\0');
}
console.log(`key=${hash.digest('hex')}`);
