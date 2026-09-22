import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
// must launder it through a plain `Class` first. `PLAIN_CLASS_NEW` pins the
// wording the patch and the merged lockfile agree on; `PLAIN_CLASS_COPY` accepts
// the same statement under a different local name so the installed check also
// holds for a previously installed revision of the same compile fix.
const PLAIN_CLASS_NEW = /Class viewClass = fd\.viewClass;/;
const PROTOCOL_CLASS_NEW = /\[fd\.viewClass new\]/;
const PLAIN_CLASS_COPY = /Class\s+\w+\s*=\s*\w+\.viewClass;/;

const mobileRequire = createRequire(path.join(mobileRoot, 'package.json'));
const reactNativeRoot = path.dirname(mobileRequire.resolve('react-native/package.json'));
const expoCliPath = mobileRequire.resolve('expo/bin/cli');
const expoPackageRoot = path.dirname(mobileRequire.resolve('expo/package.json'));

function readInstalledReactNative(relativePath: string): string {
  return fs.readFileSync(path.join(reactNativeRoot, relativePath), 'utf8');
}

// Runs Expo's own config step in introspection mode. `expo config --type
// introspect` resolves app.config.ts and executes every config plugin's mods in
// memory, emitting the native files a prebuild would write without touching the
// tree. Reading the generated `ios/Podfile.properties.json` proves the
// expo-build-properties plugin still maps our option, so an Expo plugin/config
// API change cannot silently leave the ObjC patch inert.
function readIntrospectedIosPodfileProperties(): Record<string, string> {
  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      [expoCliPath, 'config', '--type', 'introspect', '--json'],
      {
        cwd: mobileRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        // GITHUB_ACTIONS mirrors CI: a checkout without the committed
        // apps/mobile/.env warns instead of throwing, so the check still
        // reaches the plugin mapping it guards.
        env: { ...process.env, EXPO_NO_TELEMETRY: '1', GITHUB_ACTIONS: '1' },
      }
    );
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`\`expo config --type introspect\` failed:\n${stderr || String(error)}`);
  }
  const config = JSON.parse(stdout) as {
    _internal?: { modResults?: { ios?: { podfileProperties?: Record<string, string> } } };
  };
  const podfileProperties = config._internal?.modResults?.ios?.podfileProperties;
  assert.ok(
    podfileProperties,
    '`expo config --type introspect` must expose the generated ios/Podfile.properties.json'
  );
  return podfileProperties;
}

// The prebuild template that turns `ios/Podfile.properties.json` into the
// generated `ios/Podfile`. `expo prebuild` unpacks `expo/template.tgz`;
// resolving it here exercises the same artifact without writing to the tree.
function readExpoIosPodfileTemplate(): string {
  const templateTgz = path.join(expoPackageRoot, 'template.tgz');
  assert.ok(fs.existsSync(templateTgz), 'expo/template.tgz must ship the iOS prebuild template');
  return execFileSync('tar', ['-xzOf', templateTgz, 'package/ios/Podfile'], { encoding: 'utf8' });
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

  const fallbackStart = source.indexOf('if (iterator == _componentViewClasses.end())');
  const fallbackEnd = source.indexOf(
    'auto componentViewClassDescriptor = iterator->second;',
    fallbackStart
  );
  assert.ok(
    fallbackStart !== -1 && fallbackEnd > fallbackStart,
    'the missing-handle fallback must sit immediately before the registered lookup'
  );

  const fallback = source.slice(fallbackStart, fallbackEnd);
  assert.doesNotMatch(
    fallback,
    protocolQualifiedNewSend,
    'no `[<descriptor>.viewClass new]` send may remain in the fallback; it is the iOS compile error from CI'
  );
  assert.match(
    fallback,
    PLAIN_CLASS_COPY,
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
  assert.match(patch, PLAIN_CLASS_NEW, 'the patch must add the untyped-Class fallback');
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

test("Expo's generated iOS project selects source-built React Native", () => {
  const podfileProperties = readIntrospectedIosPodfileProperties();

  assert.equal(
    podfileProperties['ios.buildReactNativeFromSource'],
    'true',
    'the generated ios/Podfile.properties.json must set ios.buildReactNativeFromSource to "true"; a renamed or dropped expo-build-properties option would leave the ObjC patch unbuilt'
  );

  assert.match(
    readExpoIosPodfileTemplate(),
    /ENV\['RCT_USE_PREBUILT_RNCORE'\]\s*\|\|=\s*podfile_properties\['ios\.buildReactNativeFromSource'\]\s*==\s*'true'\s*\?\s*'0'\s*:\s*'1'/,
    'the generated ios/Podfile must export RCT_USE_PREBUILT_RNCORE=0 when ios.buildReactNativeFromSource is true so the patched ObjC compiles'
  );
});
