// Learn more https://docs.expo.io/guides/customizing-metro
const path = require('node:path');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const { withNativewind } = require('nativewind/metro');

const monorepoRoot = path.resolve(__dirname, '../..');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getSentryExpoConfig(__dirname);

// Allow Metro to resolve workspace files and pnpm's real package paths
config.watchFolders = [...new Set([...(config.watchFolders || []), monorepoRoot])];

// Let workspace package dependencies (jotai, zod, etc.) resolve from the monorepo root node_modules
config.resolver.nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths || []),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Keep colocated tests out of the app bundle. Expo Router's require.context matches
// every `.tsx` under `src/app`, so a `*.test.tsx` next to a route registers as a route
// and drags vitest (and vite) into the bundle, which Metro cannot transform.
config.resolver.blockList = [
  ...(config.resolver.blockList || []),
  /[\\/]apps[\\/]mobile[\\/]src[\\/].*\.test\.[jt]sx?$/,
];

// Drop the unused Material Symbols font chain from the bundle.
//
// `expo-router`'s <Tabs> statically pulls `expo-symbols` (via withLayoutContext ->
// native-tabs -> materialIconConverter.android). `expo-symbols` require()s all 7
// Android Material Symbols weights (~6.7MB) at module scope, through both the
// `@expo-google-fonts/material-symbols` barrel (SymbolView) and the per-weight
// subpaths (android/weights/*). This app renders lucide icons and never renders
// <NativeTabs>/<SymbolView>, so those fonts are loaded-but-unused: the `.ttf`
// values are only consumed lazily inside SymbolView (via useFonts), which is
// never mounted. Resolving these specifiers to an empty module removes the font
// bytes while leaving the never-rendered code paths harmlessly referencing
// `undefined`. iOS uses native SF Symbols and never reaches this chain.
const MATERIAL_SYMBOLS_PKG = '@expo-google-fonts/material-symbols';
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === MATERIAL_SYMBOLS_PKG || moduleName.startsWith(`${MATERIAL_SYMBOLS_PKG}/`)) {
    return { type: 'empty' };
  }
  const resolve = upstreamResolveRequest || context.resolveRequest;
  return resolve(context, moduleName, platform);
};

module.exports = withNativewind(config, { inlineVariables: false });
