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

module.exports = withNativewind(config, {
  inlineVariables: false,
});
