import assert from 'node:assert/strict';
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
const appConfigPath = path.join(mobileRoot, 'app.config.ts');

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
});

test('the installed RCTComponentViewFactory takes the lock and guards a registration miss', () => {
  const source = readInstalledReactNative('React/Fabric/Mounting/RCTComponentViewFactory.mm');

  assert.match(source, /_registerComponentViewClassLocked/, 'the locked helper must be present');
  assert.match(
    source,
    /RCTUnimplementedViewComponentView class/,
    'a missed component handle must mount the unimplemented fallback view instead of dereferencing end()'
  );
});

// The iOS build failure this guards (CI runs 34766965172, 34767975981, 34769368771):
//   RCTComponentViewFactory.mm:223:31: error: class method 'new' not found ; did you mean 'now'?
// `RCTComponentViewClassDescriptor.viewClass` is `Class<RCTComponentViewProtocol>` and that
// protocol declares no `+new`, so `[<descriptor>.viewClass new]` does not compile. React Native's
// own construction copies the value into an untyped `Class` first, where `+new` resolves against
// NSObject. The fallback added by this patch must do the same.
const protocolQualifiedNewSend = /\[\s*[A-Za-z_][A-Za-z0-9_]*\.viewClass\s+new\s*\]/;

test('RCTComponentViewProtocol declares no +new, so a protocol-qualified viewClass cannot be sent new', () => {
  const protocol = readInstalledReactNative('React/Fabric/Mounting/RCTComponentViewProtocol.h');
  assert.doesNotMatch(
    protocol,
    /^\s*\+\s*\([^)]*\)\s*new\b/m,
    'the compile error relies on RCTComponentViewProtocol not declaring +new'
  );

  const descriptor = readInstalledReactNative(
    'React/Fabric/Mounting/RCTComponentViewClassDescriptor.h'
  );
  assert.match(
    descriptor,
    /Class<RCTComponentViewProtocol>\s+viewClass;/,
    'RCTComponentViewClassDescriptor.viewClass is protocol-qualified, which restricts +new lookup'
  );
});

test('the installed fallback copies viewClass into an untyped Class before sending new', () => {
  const source = readInstalledReactNative('React/Fabric/Mounting/RCTComponentViewFactory.mm');

  assert.doesNotMatch(
    source,
    protocolQualifiedNewSend,
    'no `[<descriptor>.viewClass new]` send may remain; it is the iOS compile error from CI'
  );
  assert.match(
    source,
    /Class fallbackViewClass = fallbackDescriptor\.viewClass;/,
    'the fallback must copy viewClass into an untyped Class before new, as the registered path does'
  );
});

test('the patch adds the untyped-Class fallback and no protocol-qualified new send', () => {
  const patch = fs.readFileSync(patchPath, 'utf8');

  assert.doesNotMatch(
    patch,
    protocolQualifiedNewSend,
    'the patch must not add a protocol-qualified +new send'
  );
  assert.match(
    patch,
    /Class fallbackViewClass = fallbackDescriptor\.viewClass;/,
    'the patch must add the untyped-Class fallback'
  );
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
