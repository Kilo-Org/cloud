#!/usr/bin/env node
// Print `key=<sha256>` for the inputs of the @kilocode/trpc declaration build.
//
// The key covers every file the declaration program reads that lives in the
// repository (from `tsgo --listFilesOnly`), the build configuration, and the
// lockfile entries of the package's importer closure, which pin every file the
// build reads under node_modules. A dependency change in another workspace does
// not move it. Any failure exits non-zero: a key that misses an input would
// restore stale declarations.
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

import { buildKeyInput } from './build-key-inputs.mjs';

const root = process.cwd();
const trpc = resolve(root, 'packages/trpc');
const listed = execFileSync(
  resolve(root, 'node_modules/.bin/tsgo'),
  ['-p', 'tsconfig.build.json', '--listFilesOnly'],
  { cwd: trpc, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);
if (listed.length === 0) throw new Error('tsgo listed no files for packages/trpc');

const files = new Set([
  'packages/trpc/package.json',
  'packages/trpc/tsconfig.json',
  'packages/trpc/tsconfig.build.json',
  'packages/trpc/rollup.config.mjs',
  // The action holds the build command, and this script decides the inputs:
  // a change to either must not reuse declarations built the old way.
  '.github/actions/trpc-declarations/action.yml',
  'scripts/trpc-declaration-key.mjs',
  'scripts/build-key-inputs.mjs',
]);
for (const file of listed) {
  const path = relative(root, resolve(trpc, file));
  if (path.startsWith('..') || path.split('/').includes('node_modules')) continue;
  files.add(path);
}

console.log(`key=${buildKeyInput(root, 'packages/trpc', files)}`);
