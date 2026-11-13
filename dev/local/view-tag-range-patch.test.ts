import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// React's renderer ships as a compiled bundle with the view-tag counter inline,
// so the app cannot seed it from its own code. `patches/react-native@0.88.0.patch`
// makes every JavaScript instance start that counter from the range it claims
// (apps/mobile/src/lib/view-tag-range.ts). A dependency bump that renames the
// counter would still apply the patch elsewhere and silently restore the shared
// tag space, so the installed bundles have to carry the seam.
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const rendererDir = path.join(
  repoRoot,
  'apps/mobile/node_modules/react-native/Libraries/Renderer/implementations'
);
const bundles = ['ReactFabric-dev.js', 'ReactFabric-prod.js', 'ReactFabric-profiling.js'];

for (const bundle of bundles) {
  test(`${bundle} starts its view tags at the range the app claims`, () => {
    const source = fs.readFileSync(path.join(rendererDir, bundle), 'utf8');
    assert.match(source, /nextReactTag = -1;/);
    assert.match(source, /globalThis\.__kiloViewTagBase/);
    assert.match(source, /if \(-1 === nextReactTag\) nextReactTag = 2 \+ kiloViewTagBase\(\);/);
  });
}
