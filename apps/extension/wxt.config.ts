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
    /*
     * WXT keeps a file that matches includeSources OR misses excludeSources, so
     * excludeSources covers everything to make this list the allowlist it reads
     * like. Without it the sources zip is the whole monorepo and AMO rejects it.
     * The list is exactly what a filtered install plus build:firefox reads; see
     * SOURCE_BUILD.md. Add a package here when the build starts reading it.
     */
    includeSources: [
      // Tailwind v4 skips gitignored paths when it scans for class names.
      '.gitignore',
      '.nvmrc',
      'SOURCE_BUILD.md',
      'package.json',
      'patches/**',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/check-pnpm.mjs',
      // A filtered pnpm install still reads every workspace manifest.
      'apps/*/package.json',
      'packages/*/package.json',
      'services/**/package.json',
      'apps/extension/.gitignore',
      'apps/extension/.oxlintrc.json',
      'apps/extension/AGENTS.md',
      'apps/extension/SOURCE_CODE_REVIEW.md',
      'apps/extension/playwright.config.ts',
      'apps/extension/tsconfig.json',
      'apps/extension/vitest.config.ts',
      'apps/extension/vitest.setup.ts',
      'apps/extension/wxt.config.ts',
      'apps/extension/entrypoints/**',
      'apps/extension/public/**',
      'apps/extension/scripts/**',
      'apps/extension/src/**',
      'apps/extension/tests/**',
      'packages/app-shared/src/**',
      'packages/cloud-agent-sdk/src/**',
      'packages/session-ingest-contracts/src/**',
    ],
    excludeSources: ['*', '**/*'],
    sourcesRoot: '../..',
  },
});
