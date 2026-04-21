// Learn more https://docs.expo.io/guides/customizing-metro
const path = require('node:path');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const { withNativewind } = require('nativewind/metro');

const monorepoRoot = path.resolve(__dirname, '../..');
const webSrc = path.resolve(monorepoRoot, 'apps', 'web', 'src');
const cloudAgentSdkPath = path.resolve(webSrc, 'lib', 'cloud-agent-sdk');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getSentryExpoConfig(__dirname);

// Allow Metro to resolve workspace files and pnpm's real package paths
config.watchFolders = [monorepoRoot];

// Let SDK dependencies (jotai, zod, etc.) resolve from the monorepo root node_modules
config.resolver.nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths || []),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Allow kilo-app code to `import { ... } from 'cloud-agent-sdk'`
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'cloud-agent-sdk': cloudAgentSdkPath,
};

// Remap `@/` imports to the web app's src/ when originating from cloud-agent-sdk
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName.startsWith('@/') &&
    context.originModulePath.includes('src/lib/cloud-agent-sdk/')
  ) {
    const remapped = path.resolve(webSrc, moduleName.slice(2));
    return context.resolveRequest(context, remapped, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativewind(config, {
  inlineVariables: false,
});
