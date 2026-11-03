#!/usr/bin/env node
// Print `key=<sha256>` for the inputs of the @kilocode/harness-sdk dist build
// (`rm -rf dist && ttsc -p tsconfig.build.json`).
//
// The key covers every repository file of the build program (from
// `tsgo --listFilesOnly`, so tsconfig.build.json's test/fixture exclusions are
// honoured), the build configuration, pnpm-lock.yaml, and the action that runs
// the build. Files under node_modules are pinned by the lockfile, so they are
// left out of the per-file hash. Any failure exits non-zero: a key that misses
// an input would restore a dist built from other sources.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const root = process.cwd();
const sdk = resolve(root, 'packages/harness-sdk');
const listed = execFileSync(
  resolve(root, 'node_modules/.bin/tsgo'),
  ['-p', 'tsconfig.build.json', '--listFilesOnly'],
  { cwd: sdk, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);
if (listed.length === 0) throw new Error('tsgo listed no files for packages/harness-sdk');

const files = new Set([
  'pnpm-lock.yaml',
  'packages/harness-sdk/package.json',
  'packages/harness-sdk/tsconfig.json',
  'packages/harness-sdk/tsconfig.build.json',
  // The action holds the build command, and this script decides the inputs:
  // a change to either must not reuse a dist built the old way.
  '.github/actions/harness-sdk-build/action.yml',
  'scripts/harness-sdk-build-key.mjs',
]);
for (const file of listed) {
  const absolute = isAbsolute(file) ? file : resolve(sdk, file);
  const path = relative(root, absolute);
  // A dependency's .d.ts comes from node_modules, which the lockfile pins. A
  // file outside the checkout has no tracked content to hash.
  if (!path || path.startsWith('..') || isAbsolute(path)) continue;
  if (path.split('/').includes('node_modules')) continue;
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
