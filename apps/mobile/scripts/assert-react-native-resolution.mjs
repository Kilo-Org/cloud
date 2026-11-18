// Fails when a package's `react-native` import reaches a styled proxy that does not
// forward every React Native export.
//
// `withNativewind` (nativewind's `globalClassNamePolyfill`) resolves every `react-native`
// import to `react-native-css/components`, a proxy whose components add `className`
// support and which names the other React Native exports it forwards. Everything it does
// not name is `undefined` for the whole module that imports it, so a package that reads
// one breaks at import time: `expo-asset` 58.0.21 reads `AssetRegistry`, so
// `Asset.fromModule` threw `Cannot read property 'getAssetByID' of undefined`, every
// `expo-font` load rejected, and `useFonts` took its error branch — which left every
// JetBrains Mono label in the system face.
//
// This script resolves the real Metro config for `expo-asset`'s import, then evaluates
// the module Metro picked against a stubbed `react-native` to read its exports.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `react-native-css`'s Metro plugin writes `nativewind-env.d.ts` relative to the cwd.
process.chdir(appDir);

const appRequire = createRequire(path.join(appDir, 'package.json'));
const config = appRequire(path.join(appDir, 'metro.config.js'));
const { resolve } = loadMetroResolver();

// `metro-resolver` is not a direct dependency: load the copy `metro` resolves, so the
// guard runs the resolver the bundle is built with.
function loadMetroResolver() {
  const candidates = [];
  try {
    candidates.push(createRequire(appRequire.resolve('metro')));
  } catch {}
  candidates.push(appRequire);
  for (const candidate of candidates) {
    try {
      return candidate('metro-resolver');
    } catch {}
  }
  throw new Error('Cannot load metro-resolver: neither it nor its `metro` host resolves.');
}

// The context mirrors `createModuleResolver` in
// `metro/src/node-haste/DependencyGraph/createModuleResolver.js`: the fields Metro's
// resolver reads, backed by the real file system and package lookups.
const packageCache = new Map();
function readPackageJson(packageJsonPath) {
  if (!packageCache.has(packageJsonPath)) {
    let packageJson = null;
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch {}
    packageCache.set(packageJsonPath, packageJson);
  }
  return packageCache.get(packageJsonPath);
}
function getPackageForModule(absolutePath) {
  let dir = path.dirname(absolutePath);
  for (;;) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = readPackageJson(packageJsonPath);
      if (packageJson === null) return null;
      return { rootPath: dir, packageJson, packageRelativePath: path.relative(dir, absolutePath) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function fileSystemLookup(filePath) {
  try {
    const realPath = fs.realpathSync.native(filePath);
    const type = fs.statSync(realPath).isDirectory() ? 'd' : 'f';
    return { exists: true, realPath, type };
  } catch {
    return { exists: false };
  }
}
const context = {
  ...config.resolver,
  allowHaste: false,
  assetExts: new Set(config.resolver.assetExts),
  customResolverOptions: {},
  doesFileExist: filePath => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  fileSystemLookup,
  getPackage: packageJsonPath => readPackageJson(packageJsonPath),
  getPackageForModule,
  mainFields: config.resolver.resolverMainFields,
  platforms: new Set(config.resolver.platforms ?? ['ios', 'android', 'native', 'web']),
  preferNativePlatform: true,
  projectRoot: config.projectRoot,
  redirectModulePath: modulePath => modulePath,
  resolveAsset: () => null,
  sourceExts: new Set(config.resolver.sourceExts),
  unstable_logWarning: () => {},
};

function packageRoot(packageName) {
  let dir = path.dirname(appRequire.resolve(packageName));
  for (;;) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (readPackageJson(packageJsonPath)?.name === packageName) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No package root found for ${packageName}.`);
    dir = parent;
  }
}

const failures = [];
function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}\n    ${detail}`);
}

// The React Native surface a package can reach through the proxy. `AssetRegistry` is the
// export expo-asset reads; the components stand for the proxy's own styled versions.
function stubReactNative() {
  const component = name => ({ name });
  const reactNative = {
    AssetRegistry: { getAssetByID: id => ({ id }) },
    Dimensions: { get: () => ({ width: 411, height: 914 }) },
    NativeModules: {},
    Platform: { OS: 'android' },
    StyleSheet: { create: styles => styles },
    Text: component('Text'),
    View: component('View'),
  };
  return reactNative;
}

// Evaluates the proxy module Metro resolved with a stubbed `react-native`, so its exports
// can be read without a device. Component submodules are stubs: this checks which
// `react-native` exports the proxy forwards, not what its components render.
function evaluateProxyExports(proxyPath) {
  const reactNative = stubReactNative();
  const anyProperty = () => () => null;
  const stubModule = () => new Proxy({}, { get: (_, property) => anyProperty() });
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: id => (id === 'react-native' ? reactNative : stubModule()),
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(proxyPath, 'utf8'), sandbox, { filename: proxyPath });
  return { exports: sandbox.module.exports, reactNative };
}

function resolveFrom(originModulePath, specifier) {
  const resolution = resolve({ ...context, originModulePath }, specifier, 'android');
  if (resolution.type !== 'sourceFile') return null;
  return resolution.filePath;
}

const STYLED_PROXY = `${path.sep}react-native-css${path.sep}`;
const expoAsset = path.join(packageRoot('expo-asset'), 'build', 'Asset.js');
const proxyPath = resolveFrom(expoAsset, 'react-native');
const resolved = `${path.relative(appDir, expoAsset)} -> 'react-native' => ${proxyPath ?? '(unresolved)'}`;

check(
  'a package resolves the styled `react-native` proxy',
  proxyPath !== null && proxyPath.includes(STYLED_PROXY),
  resolved
);

if (proxyPath !== null && proxyPath.includes(STYLED_PROXY)) {
  const { exports: proxyExports, reactNative } = evaluateProxyExports(proxyPath);
  for (const name of ['AssetRegistry', 'Dimensions', 'NativeModules', 'Platform']) {
    check(
      `the proxy forwards \`${name}\``,
      proxyExports[name] === reactNative[name],
      `\`${name}\` is ${proxyExports[name] === undefined ? 'undefined' : 'a different value'} through the proxy`
    );
  }
  for (const name of ['Text', 'View']) {
    check(
      `the proxy keeps its styled \`${name}\``,
      proxyExports[name] !== undefined && proxyExports[name] !== reactNative[name],
      `\`${name}\` is ${proxyExports[name] === undefined ? 'undefined' : 'the real component, not the styled one'} through the proxy`
    );
  }
}

if (failures.length > 0) {
  console.error(`\nreact-native resolution is wrong in ${failures.length} case(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nSee the proxy patch in patches/react-native-css.patch.\n');
  process.exit(1);
}

console.log(resolved);
