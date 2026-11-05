#!/usr/bin/env node
// Print `key=<sha256>` for the inputs of the @kilocode/harness-sdk dist build
// (`rm -rf dist && ttsc -p tsconfig.build.json`).
//
// The key covers every repository file of the build program (from
// `tsgo --listFilesOnly`, so tsconfig.build.json's test/fixture exclusions are
// honoured), the build configuration, and the lockfile entries of the package's
// importer closure, which pin every file the build reads under node_modules. A
// dependency change in another workspace does not move it. Any failure exits
// non-zero: a key that misses an input would restore a dist built from other
// sources.
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

import { buildKeyInput } from './build-key-inputs.mjs';

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
  'packages/harness-sdk/package.json',
  'packages/harness-sdk/tsconfig.json',
  'packages/harness-sdk/tsconfig.build.json',
  // The action holds the build command, and this script decides the inputs:
  // a change to either must not reuse a dist built the old way.
  '.github/actions/harness-sdk-build/action.yml',
  'scripts/harness-sdk-build-key.mjs',
  'scripts/build-key-inputs.mjs',
]);
for (const file of listed) {
  const absolute = isAbsolute(file) ? file : resolve(sdk, file);
  const path = relative(root, absolute);
  // A dependency's .d.ts comes from node_modules, which the closure pins. A
  // file outside the checkout has no tracked content to hash.
  if (!path || path.startsWith('..') || isAbsolute(path)) continue;
  if (path.split('/').includes('node_modules')) continue;
  files.add(path);
}

console.log(`key=${buildKeyInput(root, 'packages/harness-sdk', files)}`);
