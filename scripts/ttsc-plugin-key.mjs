#!/usr/bin/env node
// Print `key=<sha256>` for the compiled ttsc compiler plugins that ttsc keeps
// in node_modules/.cache/ttsc/plugins.
//
// ttsc compiles the typia transform from its own sources on first use. Only the
// resolved versions of the packages that build that transform - ttsc, typia,
// @ttsc/unplugin and the TypeScript they run on - can change what it writes, so
// the key covers their lockfile closure and not the whole lockfile: a
// dependency change elsewhere in the monorepo keeps the compiled plugin. A
// closure failure widens the key to the whole lockfile, so a wider key only
// costs a miss and never restores a plugin built from other versions.
import { buildKeyInput } from './build-key-inputs.mjs';

const plugins = ['ttsc', 'typia', '@ttsc/unplugin', 'typescript'];
const files = [
  'packages/harness-sdk/package.json',
  'packages/harness-sdk/tsconfig.json',
  // The action holds the cache steps, and this script decides the inputs: a
  // change to either must not reuse plugins restored the old way.
  '.github/actions/ttsc-plugin-cache/action.yml',
  'scripts/ttsc-plugin-key.mjs',
  'scripts/build-key-inputs.mjs',
];

console.log(`key=${buildKeyInput(process.cwd(), 'packages/harness-sdk', files, plugins)}`);
