import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards the Android cold-start SIGSEGV (proof-fc429a8 e1): the JS thread's
// MountingCoordinator::pullTransaction locks the coordinator's weak_ptr to
// react-native-screens' ScreenRemovalListener while NativeProxy teardown frees
// the listener, and the virtual call lands on freed memory (SIGSEGV
// SEGV_ACCERR on mqt_v_js, tombstone pc MountingCoordinator::pullTransaction+713,
// in the prebuilt libreactnative.so). RN core's delegate list is append-only,
// so the only fix that reaches a prebuilt RN AAR is on the screens side: the
// listener becomes process-immortal and swaps its callback instead of being
// replaced — the upstream fix carried verbatim from
// software-mansion/react-native-screens#4413 (shipped in 4.28.0). Screens
// builds its C++ from source on Android, so the patched sources compile into
// librnscreens.so without a from-source RN build.
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const patchRelativePath = 'patches/react-native-screens@4.26.2.patch';
const patchPath = path.join(repoRoot, patchRelativePath);
const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml');

const mobileRequire = createRequire(path.join(repoRoot, 'apps', 'mobile', 'package.json'));
const screensRoot = path.dirname(mobileRequire.resolve('react-native-screens/package.json'));

function readInstalledScreens(relativePath: string): string {
  return fs.readFileSync(path.join(screensRoot, relativePath), 'utf8');
}

test('pnpm-workspace.yaml registers the react-native-screens 4.26.2 patch', () => {
  const workspace = fs.readFileSync(workspacePath, 'utf8');

  assert.match(
    workspace,
    /^ {2}react-native-screens@4\.26\.2: patches\/react-native-screens@4\.26\.2\.patch$/m,
    'pnpm-workspace.yaml must declare react-native-screens@4.26.2 under patchedDependencies'
  );
});

test('the patch carries the upstream process-lifetime listener (#4413) verbatim', () => {
  assert.ok(
    fs.existsSync(patchPath),
    `${patchRelativePath} must exist (created with \`pnpm patch react-native-screens@4.26.2\`)`
  );
  const patch = fs.readFileSync(patchPath, 'utf8');

  assert.match(
    patch,
    /software-mansion\/react-native-screens\/pull\/4413/,
    'the patch must cite the upstream fix it carries'
  );
  assert.match(
    patch,
    /removalListener\(\)/,
    'NativeProxy must hand core the process-immortal listener instead of a per-proxy one'
  );
  const added = patch
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  assert.doesNotMatch(
    added,
    /std::make_shared<RNSScreenRemovalListener>\(\[this\]/,
    'no added line may build a per-proxy listener; its death is the use-after-free'
  );
  assert.match(
    patch,
    /\[javaPart = javaPart_\]/,
    'the callback must capture a copy of the global ref, not `this` of the dying proxy'
  );
  assert.match(
    patch,
    /clearListener\(removalListenerToken_\)/,
    'invalidateNative must disarm the listener through the ownership token'
  );
});

test('the installed ScreenRemovalListener is immortal and thread-safe', () => {
  const header = readInstalledScreens('cpp/RNSScreenRemovalListener.h');

  assert.match(header, /RNSScreenRemovalListener\(\) = default;/, 'default constructible');
  assert.match(header, /uint64_t setListener\(/, 'callback swap entry point');
  assert.match(header, /void clearListener\(uint64_t token\);/, 'token-guarded disarm');
  assert.match(header, /mutable std::mutex listenerMutex_;/, 'listener state must be locked');

  const source = readInstalledScreens('cpp/RNSScreenRemovalListener.cpp');
  assert.match(
    source,
    /if \(!listener\) \{[\s\S]*pass the[\s\S]*transaction through/,
    'an orphaned listener must pass the transaction through instead of calling null'
  );
});

test('the installed NativeProxy no longer owns the listener', () => {
  const header = readInstalledScreens('android/src/main/cpp/NativeProxy.h');

  assert.doesNotMatch(
    header,
    /std::shared_ptr<RNSScreenRemovalListener> screenRemovalListener_/,
    'the proxy-owned shared_ptr is what dropped the last ref mid-pull; it must be gone'
  );
  assert.match(header, /std::mutex installMutex_;/, 'install must serialize with invalidate');
  assert.match(header, /uint64_t removalListenerToken_\{0\};/, 'ownership token member');

  const source = readInstalledScreens('android/src/main/cpp/NativeProxy.cpp');
  assert.match(source, /coordinator->setMountingOverrideDelegate\(removalListener\(\)\)/);
  assert.match(
    source,
    /removalListener\(\)->clearListener\(removalListenerToken_\)/,
    'invalidateNative must disarm before the hybrid is collected'
  );
});

test('pnpm-lock.yaml records the sha256 of the screens patch', () => {
  const lockfile = fs.readFileSync(lockfilePath, 'utf8');
  const hash = createHash('sha256').update(fs.readFileSync(patchPath)).digest('hex');

  assert.match(
    lockfile,
    new RegExp(`^ {2}react-native-screens@4\\.26\\.2: ${hash}$`, 'm'),
    'patchedDependencies must pin the patch file sha256 so pnpm applies the same patch CI installs'
  );

  const recorded = lockfile.match(/react-native-screens@4\.26\.2\(patch_hash=[0-9a-f]+/g) ?? [];
  assert.ok(recorded.length > 0, 'the lockfile must reference the patched react-native-screens');
  for (const entry of recorded) {
    assert.equal(
      entry,
      `react-native-screens@4.26.2(patch_hash=${hash}`,
      'every locked react-native-screens reference must use the current patch hash'
    );
  }
});
