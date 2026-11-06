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
//
// The harness SDK's manifest and tsconfig are deliberately absent. The cache
// holds the plugin binary, and ttsc keys that binary on the plugin sources, its
// own overlay, the Go toolchain and the platform: an edit to either file that
// leaves those four resolutions alone cannot change it. typia reads
// compilerOptions at transform time from the tsconfig in front of it, so a
// restored binary still honours the current options.
import { buildKeyInput } from './build-key-inputs.mjs';

const plugins = ['ttsc', 'typia', '@ttsc/unplugin', 'typescript'];
// The action holds the cache steps, and this script decides the inputs: a
// change to either must not reuse plugins restored the old way.
export const files = [
  '.github/actions/ttsc-plugin-cache/action.yml',
  'scripts/ttsc-plugin-key.mjs',
  'scripts/build-key-inputs.mjs',
];

export function pluginKey(root) {
  return buildKeyInput(root, 'packages/harness-sdk', files, plugins);
}

if (import.meta.main) console.log(`key=${pluginKey(process.cwd())}`);
