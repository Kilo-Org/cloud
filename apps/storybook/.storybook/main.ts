import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { StorybookConfig } from '@storybook/nextjs';
import { config as dotenvConfig } from 'dotenv';
import { expand } from 'dotenv-expand';
import webpack from 'webpack';

// Load environment variables from .env files
// This follows Next.js convention: .env.local > .env.development > .env
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const webRoot = resolve(repoRoot, 'apps/web');
expand(dotenvConfig({ path: resolve(repoRoot, '.env.local') }));
expand(dotenvConfig({ path: resolve(webRoot, '.env.development') }));
expand(dotenvConfig({ path: resolve(webRoot, '.env') }));

const storybookPublicEnvDefaults = {
  NEXT_PUBLIC_EVENT_SERVICE_URL: 'https://event-service.storybook.invalid',
  NEXT_PUBLIC_GASTOWN_URL: 'https://gastown.storybook.invalid',
  NEXT_PUBLIC_KILO_CHAT_URL: 'https://kilo-chat.storybook.invalid',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  NEXT_PUBLIC_WASTELAND_URL: 'https://wasteland.storybook.invalid',
} satisfies Record<string, string>;

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  framework: {
    name: '@storybook/nextjs',
    options: {
      nextConfigPath: '../web/next.config.mjs',
    },
  },
  staticDirs: ['../../web/public', '../public'],
  webpackFinal: async config => {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/src');
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

  for (const [key, defaultValue] of Object.entries(storybookPublicEnvDefaults)) {
    definitions[`process.env.${key}`] = JSON.stringify(process.env[key] ?? defaultValue);
  }

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
