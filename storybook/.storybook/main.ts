import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { StorybookConfig } from '@storybook/nextjs';
import { config as dotenvConfig } from 'dotenv';
import { expand } from 'dotenv-expand';
import webpack from 'webpack';

// Load environment variables from .env files
// This follows Next.js convention: .env.local > .env.development > .env
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
expand(dotenvConfig({ path: resolve(projectRoot, '.env.local') }));
expand(dotenvConfig({ path: resolve(projectRoot, '.env.development') }));
expand(dotenvConfig({ path: resolve(projectRoot, '.env') }));

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: ['@storybook/addon-links', '@storybook/addon-docs', '@storybook/addon-themes'],
  framework: {
    name: '@storybook/nextjs',
    options: {
      nextConfigPath: '../../next.config.mjs',
    },
  },
  staticDirs: ['../../public', '../public'],
  webpackFinal: async config => {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    const mocksDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/mocks');

    if (config.resolve) {
      config.resolve.alias = {
        ...config.resolve.alias,
        '@': srcDir,
        '@/lib/utils': resolve(mocksDir, 'utils.ts'),
      };
    }

    // Inject all NEXT_PUBLIC_ environment variables for Storybook
    const envDefinitions = getNextPublicEnvDefinitions();
    config.plugins ||= [];
    config.plugins.push(new webpack.DefinePlugin(envDefinitions));

    // Mock server-only actions for Storybook (they use 'server-only' which fails in client contexts)
    // Use NormalModuleReplacementPlugin for reliable module replacement regardless of import path
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /InsufficientBalanceBanner\.actions$/,
        resolve(mocksDir, 'InsufficientBalanceBanner.actions.ts')
      )
    );

    return config;
  },
  typescript: {
    reactDocgen: 'react-docgen-typescript',
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      propFilter: prop => (prop.parent ? !/node_modules/.test(prop.parent.fileName) : true),
    },
  },
};

/**
 * Collect all NEXT_PUBLIC_ environment variables and create DefinePlugin definitions
 * This automatically makes all Next.js public env vars available in Storybook
 */
function getNextPublicEnvDefinitions() {
  const definitions: Record<string, string> = {};

  // Find all NEXT_PUBLIC_ variables in process.env
  // eslint-disable-next-line n/no-process-env
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NEXT_PUBLIC_')) {
      definitions[`process.env.${key}`] = JSON.stringify(value);
    }
  }

  return definitions;
}

export default config;
