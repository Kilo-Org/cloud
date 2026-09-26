import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const PATCH_RELATIVE = 'patches/react-native@0.86.3.patch';
const VIEW_SOURCE_RELATIVE = 'React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm';
// The upstream bug: the RCTAssert failure message formats the child tag with an
// unchecked index. A stale Fabric index throws NSRangeException while the assert
// is being reported, which aborts assert-enabled release builds.
const UNGUARDED_TAG_ARGUMENT = '@([[self.currentContainerView.subviews objectAtIndex:index] tag])';

test('registers the react-native 0.86.3 patch in pnpm-workspace.yaml', () => {
  const workspace = fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /^ {2}react-native@0\.86\.3: patches\/react-native@0\.86\.3\.patch$/m);
});

test('carries the bounds-safe assert hunk in the react-native patch', () => {
  const patchPath = path.join(repoRoot, PATCH_RELATIVE);
  assert.ok(fs.existsSync(patchPath), `${PATCH_RELATIVE} must exist`);
  const patch = fs.readFileSync(patchPath, 'utf8');
  assert.ok(
    patch.includes('#ifndef NS_BLOCK_ASSERTIONS'),
    'patch must guard the assert with #ifndef NS_BLOCK_ASSERTIONS'
  );
  assert.ok(patch.includes('isIndexInBounds'), 'patch must bounds-check the child index');
});

test('installs the patched RCTViewComponentView', () => {
  const mobileRequire = createRequire(path.join(repoRoot, 'apps', 'mobile', 'package.json'));
  const installedSource = fs.readFileSync(
    path.join(
      path.dirname(mobileRequire.resolve('react-native/package.json')),
      VIEW_SOURCE_RELATIVE
    ),
    'utf8'
  );
  assert.ok(
    installedSource.includes('isIndexInBounds'),
    'installed RCTViewComponentView.mm must carry the bounds guard'
  );
  assert.ok(
    !installedSource.includes(UNGUARDED_TAG_ARGUMENT),
    'installed RCTViewComponentView.mm must not format the assert message with an unchecked index'
  );
});

test('compiles React Native from source for iOS', () => {
  const appConfig = fs.readFileSync(path.join(repoRoot, 'apps', 'mobile', 'app.config.ts'), 'utf8');
  assert.match(appConfig, /buildReactNativeFromSource\s*:\s*true/);
});
