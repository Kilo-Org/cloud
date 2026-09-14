import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards the KILO-APP-6H fix: react/react-native#58299 races the JS thread's
// `_registerComponentIfPossible:` with the main thread's mounting transaction,
// crashing in `createComponentViewWithComponentHandle:` (EXC_BAD_ACCESS 0x18).
// The fix is a pnpm patch over react-native, the LegacyViewManagerInterop
// `@synchronized` guard, and a source build of RN core so the patched ObjC
// actually compiles into the app.
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const mobileRoot = path.join(repoRoot, 'apps', 'mobile');
const patchRelativePath = 'patches/react-native@0.86.3.patch';
const patchPath = path.join(repoRoot, patchRelativePath);
const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml');
const appConfigPath = path.join(mobileRoot, 'app.config.ts');

// `createComponentViewWithComponentHandle:` stores the view class in a
// protocol-qualified `Class<RCTComponentViewProtocol>` field. Sending `new` to
// that field fails to compile ("class method 'new' not found"), so the fallback
// must launder it through a plain `Class` first.
const PLAIN_CLASS_NEW = /Class viewClass = fd\.viewClass;/;
const PROTOCOL_CLASS_NEW = /\[fd\.viewClass new\]/;

const mobileRequire = createRequire(path.join(mobileRoot, 'package.json'));
const reactNativeRoot = path.dirname(mobileRequire.resolve('react-native/package.json'));

function readInstalledReactNative(relativePath: string): string {
  return fs.readFileSync(path.join(reactNativeRoot, relativePath), 'utf8');
}

test('pnpm-workspace.yaml registers the react-native 0.86.3 patch', () => {
  const workspace = fs.readFileSync(workspacePath, 'utf8');

  assert.match(
    workspace,
    /^ {2}react-native@0\.86\.3: patches\/react-native@0\.86\.3\.patch$/m,
    'pnpm-workspace.yaml must declare react-native@0.86.3 under patchedDependencies'
  );
});

test('the react-native patch contains the registration-lock and fallback-guard hunks', () => {
  assert.ok(
    fs.existsSync(patchPath),
    `${patchRelativePath} must exist (created with \`pnpm patch react-native@0.86.3\`)`
  );
  const patch = fs.readFileSync(patchPath, 'utf8');

  assert.match(
    patch,
    /_registerComponentViewClassLocked/,
    'patch must add the locked registration helper'
  );
  assert.match(
    patch,
    /RCTUnimplementedViewComponentView/,
    'patch must add the createComponentViewWithComponentHandle fallback view'
  );
  assert.match(patch, /@synchronized/, 'patch must synchronize the LegacyViewManagerInterop cache');
  assert.match(
    patch,
    PLAIN_CLASS_NEW,
    'patch must copy the fallback class into a plain Class before calling -new'
  );
  assert.doesNotMatch(
    patch,
    PROTOCOL_CLASS_NEW,
    'patch must not send -new to the protocol-qualified Class field; clang fails with "class method new not found"'
  );
});

test('the installed RCTComponentViewFactory takes the lock and guards a registration miss', () => {
  const source = readInstalledReactNative('React/Fabric/Mounting/RCTComponentViewFactory.mm');

  assert.match(source, /_registerComponentViewClassLocked/, 'the locked helper must be present');
  assert.match(
    source,
    /RCTUnimplementedViewComponentView class/,
    'a missed component handle must mount the unimplemented fallback view instead of dereferencing end()'
  );
  assert.match(
    source,
    PLAIN_CLASS_NEW,
    'the installed fallback must instantiate its view through a plain Class (compile fix)'
  );
  assert.doesNotMatch(
    source,
    PROTOCOL_CLASS_NEW,
    'the installed fallback must not send -new to a protocol-qualified Class field'
  );
});

test('pnpm-lock.yaml records the sha256 of the react-native patch', () => {
  const lockfile = fs.readFileSync(lockfilePath, 'utf8');
  const hash = createHash('sha256').update(fs.readFileSync(patchPath)).digest('hex');

  assert.match(
    lockfile,
    new RegExp(`^ {2}react-native@0\\.86\\.3: ${hash}$`, 'm'),
    'patchedDependencies must pin the patch file sha256 so pnpm applies the same patch CI installs'
  );

  const recorded = lockfile.match(/react-native@0\.86\.3\(patch_hash=[0-9a-f]+/g) ?? [];
  assert.ok(recorded.length > 0, 'the lockfile must reference the patched react-native');
  for (const entry of recorded) {
    assert.equal(
      entry,
      `react-native@0.86.3(patch_hash=${hash}`,
      'every locked react-native reference must use the current patch hash'
    );
  }
});

test('the installed LegacyViewManagerInterop cache is synchronized', () => {
  const source = readInstalledReactNative(
    'React/Fabric/Mounting/ComponentViews/LegacyViewManagerInterop/RCTLegacyViewManagerInteropComponentView.mm'
  );

  assert.match(
    source,
    /@synchronized\s*\(\s*supportedLegacyViewComponents\s*\)/,
    'the JS-thread cache write must be synchronized'
  );
});

test('iOS builds React Native core from source so the patch is compiled in', () => {
  const appConfig = fs.readFileSync(appConfigPath, 'utf8');

  assert.match(
    appConfig,
    /buildReactNativeFromSource\s*:\s*true/,
    'expo-build-properties ios.buildReactNativeFromSource must be true'
  );
});
