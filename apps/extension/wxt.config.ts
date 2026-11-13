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
    // WXT globs every file under `sourcesRoot` and keeps one when it matches
    // `includeSources` OR misses `excludeSources`, so this list only acts as
    // the allowlist it reads like while `excludeSources` covers everything: a
    // sources zip of the whole monorepo is about 490 MB uncompressed and AMO
    // rejects the upload. What follows is the whole of
    // `pnpm install --filter kilo-extension...` plus `build:firefox`; see
    // SOURCE_BUILD.md, which ships in the zip as the reviewer instructions.
    // Add a package here when the build starts reading its source.
    includeSources: [
      // Tailwind v4 scans the tree for class candidates and skips the paths
      // these files ignore, so a build without them emits utilities the release
      // build never had.
      '.gitignore',
      '.nvmrc',
      'SOURCE_BUILD.md',
      'package.json',
      'patches/**',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/check-pnpm.mjs',
      // pnpm resolves the workspace graph from the lockfile and every project
      // manifest, even for a filtered install, so each project contributes its
      // package.json and nothing else.
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
