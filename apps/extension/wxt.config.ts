import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

const posthogApiKey = process.env['VITE_POSTHOG_API_KEY'];
if (posthogApiKey === undefined || posthogApiKey.trim().length === 0) {
  console.warn(
    'VITE_POSTHOG_API_KEY is not set; extension analytics will be disabled in this build.'
  );
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: ({ browser }) => ({
    action: {
      default_title: 'Kilo',
    },
    browser_specific_settings: {
      gecko: {
        data_collection_permissions: {
          optional: ['technicalAndInteraction'],
          required: ['personallyIdentifyingInfo'],
        },
        id: 'browser-agent@kilo.ai',
      },
    },
    description: 'Side-panel AI chat agent. Use open-weight or frontier models.',
    host_permissions: [
      '<all_urls>',
      'file:///*',
      'https://app.kilo.ai/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    name: 'Kilo Code',
    permissions:
      browser === 'firefox'
        ? ['contextMenus', 'identity', 'scripting', 'storage', 'tabs']
        : ['contextMenus', 'debugger', 'identity', 'scripting', 'storage'],
  }),
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  zip: {
    includeSources: [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'patches/**',
      'apps/extension/AGENTS.md',
      'apps/extension/SOURCE_CODE_REVIEW.md',
      'apps/extension/package.json',
      'apps/extension/playwright.config.ts',
      'apps/extension/tsconfig.json',
      'apps/extension/vitest.config.ts',
      'apps/extension/wxt.config.ts',
      'apps/extension/entrypoints/**',
      'apps/extension/public/**',
      'apps/extension/scripts/**',
      'apps/extension/src/**',
      'apps/extension/tests/e2e/**',
      'packages/cloud-agent-sdk/package.json',
      'packages/cloud-agent-sdk/src/**',
      'packages/container-usage/package.json',
      'packages/container-usage/src/contracts.ts',
      'packages/app-shared/package.json',
      'packages/app-shared/src/**',
    ],
    sourcesRoot: '../..',
  },
});
