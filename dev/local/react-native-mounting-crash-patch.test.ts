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
