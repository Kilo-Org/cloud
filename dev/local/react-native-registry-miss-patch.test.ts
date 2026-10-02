import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards the KILO-APP-35C fix. A Fabric mount instruction can name a tag that
// `RCTComponentViewRegistry` no longer holds, and `RCTPerformMountInstructions`
// then applies a `Remove` for it (`RCTMountingManager.mm:98`). Release builds
// compile `RCTAssert` out (`ENABLE_NS_ASSERTIONS = NO`), so the untolerant
// lookup returned `iterator->second` of `end()` and the caller's `.view` load
// faulted at 0x18 (EXC_BAD_ACCESS, main thread; KILO-APP-35C, KILO-APP-39V).
// The fix is a pnpm patch over react-native: the lookup reports the tag and
// returns an empty descriptor, the mount pass skips an instruction whose child
// view is gone, and the recycle pool refuses a descriptor without a view. This
// file pins the patch and the installed ObjC so a regenerated patch or a
// dependency bump cannot leave the crash in place.
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const mobileRoot = path.join(repoRoot, 'apps', 'mobile');
const patchRelativePath = 'patches/react-native@0.86.3.patch';
const patchPath = path.join(repoRoot, patchRelativePath);

const mobileRequire = createRequire(path.join(mobileRoot, 'package.json'));
const reactNativeRoot = path.dirname(mobileRequire.resolve('react-native/package.json'));

function readInstalledReactNative(relativePath: string): string {
  return fs.readFileSync(path.join(reactNativeRoot, relativePath), 'utf8');
}

function readInstalledRegistryLookup(): string {
  const source = readInstalledReactNative('React/Fabric/Mounting/RCTComponentViewRegistry.mm');
  const start = source.indexOf('- (const RCTComponentViewDescriptor &)componentViewDescriptorWithTag:');
  const end = source.indexOf('- (nullable UIView<RCTComponentViewProtocol> *)findComponentViewWithTag:');
  assert.ok(
    start !== -1 && end > start,
    'the registry must keep `componentViewDescriptorWithTag:` directly before `findComponentViewWithTag:`'
  );
  return source.slice(start, end);
}

test('the react-native patch reports a registry lookup miss instead of dereferencing end()', () => {
  assert.ok(
    fs.existsSync(patchPath),
    `${patchRelativePath} must exist (created with \`pnpm patch react-native@0.86.3\`)`
  );
  const patch = fs.readFileSync(patchPath, 'utf8');

  assert.match(
    patch,
    /^\+#import <React\/RCTLog\.h>$/m,
    'the patch must import React/RCTLog.h for the miss report'
  );
  assert.match(
    patch,
    /^ +RCTAssert\(iterator != _registry\.end\(\), @"RCTComponentViewRegistry: Attempt to query unregistered component\."\);$/m,
    'the patch must keep the Debug assert so a dev build still throws on an unregistered tag'
  );
  assert.match(
    patch,
    /^\+  if \(iterator == _registry\.end\(\)\) \{$/m,
    'the patch must branch on the miss before returning a reference'
  );
  assert.match(
    patch,
    /^\+    RCTLogError\($/m,
    'the patch must report the missing tag so the next occurrence names it'
  );
  assert.match(
    patch,
    /^\+    static const RCTComponentViewDescriptor \w+\{\};$/m,
    'the patch must return an empty descriptor so no caller reads a past-the-end value'
  );
  assert.match(
    patch,
    /skipping Remove for unregistered component view/,
    'the patch must skip a Remove whose child view is gone'
  );
  assert.match(
    patch,
    /skipping Remove with unregistered parent view/,
    'the patch must skip a Remove whose parent view is gone'
  );
  assert.match(
    patch,
    /skipping Insert for unregistered component view/,
    'the patch must skip an Insert whose child view is gone'
  );
});

test('the installed registry returns an empty descriptor and logs the tag on a miss', () => {
  const lookup = readInstalledRegistryLookup();

  assert.match(
    lookup,
    /RCTAssert\(\s*iterator != _registry\.end\(\),/,
    'the Debug assert on an unregistered tag must stay'
  );
  assert.match(
    lookup,
    /if \(iterator == _registry\.end\(\)\) \{/,
    'the lookup must branch on the miss before returning a reference'
  );
  assert.match(lookup, /RCTLogError\(/, 'the miss must be reported');
  assert.match(
    lookup,
    /\(tag: %lld\)/,
    'the report must carry the tag that was not registered'
  );
  assert.match(
    lookup,
    /static const RCTComponentViewDescriptor \w+\{\};/,
    'the miss must return an empty descriptor instead of `iterator->second`'
  );

  const guardEnd = lookup.indexOf('static const RCTComponentViewDescriptor');
  assert.ok(guardEnd !== -1, 'the empty-descriptor guard must be present');
  assert.ok(
    lookup.lastIndexOf('return iterator->second;') > guardEnd,
    'the registered path must still return the stored descriptor after the miss guard'
  );
});

test('the installed recycle pool refuses a descriptor that has no view', () => {
  const source = readInstalledReactNative('React/Fabric/Mounting/RCTComponentViewRegistry.mm');
  const enqueueStart = source.indexOf('- (void)_enqueueComponentViewWithComponentHandle:');
  assert.ok(enqueueStart !== -1, 'the recycle pool must keep its enqueue helper');
  const enqueue = source.slice(enqueueStart);

  assert.match(
    enqueue,
    /if \(\s*componentViewDescriptor\.view == nil \|\|/,
    'an empty descriptor must not enter the recycle pool; a later mount would insert a nil child view'
  );
});

test('the installed mount pass skips a mutation whose child view is gone', () => {
  const source = readInstalledReactNative('React/Fabric/Mounting/RCTMountingManager.mm');

  const insertGuard = source.indexOf('if (newChildComponentView == nil) {');
  const insertSend = source.indexOf(
    '[parentViewDescriptor.view mountChildComponentView:newChildComponentView'
  );
  assert.ok(insertGuard !== -1, 'the Insert case must skip a child view the registry lost');
  assert.ok(
    insertGuard < insertSend,
    'the Insert guard must run before the mount send, which raises on a nil child'
  );

  const removeChildGuard = source.indexOf('if (oldChildViewDescriptor.view == nil) {');
  const removeParentGuard = source.indexOf('if (parentViewDescriptor.view == nil) {');
  const removeSend = source.indexOf('[parentViewDescriptor.view unmountChildComponentView:');
  assert.ok(removeChildGuard !== -1, 'the Remove case must skip a mutation whose child view is gone');
  assert.ok(removeParentGuard !== -1, 'the Remove case must skip a mutation whose parent view is gone');
  assert.ok(
    removeChildGuard < removeSend && removeParentGuard < removeSend,
    'the Remove guards must run before the unmount send, which removes an unrelated view at a stale index'
  );
});
