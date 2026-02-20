import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  ignore: [
    // Used via TypeScript path mapping in tsconfig.scripts.json ("server-only" -> this file)
    'src/scripts/lib/server-only-shim.ts',
  ],

  // Ignore dependencies that are used indirectly or intentionally unused
  ignoreDependencies: [
    // Used via radix-ui but not directly imported
    '@radix-ui/react-toggle',

    // Used in specific contexts or planned for future use
    '@uiw/react-json-view',

    // Used via plugins or extends (detected by custom compiler now)
    'eslint-config-next',
    'eslint-config-prettier',

    // Utility dependencies used in scripts
    'brace-expansion',

    // Alternative test runner
    'ts-jest',

    // Used in client-side code
    'client-only',

    // Used in scripts
    'dotenv/config',
  ],

  // Binaries that are used but not listed in dependencies
  ignoreBinaries: [
    'cmp', // System command used in GitHub workflows
    'stripe', // Stripe CLI tool
    'only-allow', // Package manager enforcement
  ],

  // Ignore exports that might be used by Next.js or imported dynamically
  ignoreExportsUsedInFile: {
    interface: true,
    type: true,
  },

  // Custom compilers to detect dependencies in non-JS files
  compilers: {
    // Parse CSS files to detect @plugin directives for Tailwind v4
    css: (text: string) => {
      const plugins = [...text.matchAll(/@(plugin|import)\s+['"]([^'"]+)['"]/g)].map(m => m[2]);
      return plugins.map(plugin => `import '${plugin}';`).join('\n');
    },
  },

  typescript: {
    config: ['tsconfig.json', 'tsconfig.scripts.json'],
  },

  // Workspace configuration
  workspaces: {
    '.': {
      entry: [
        // Scripts are valid dev-only entry points
        'src/scripts/**/*.ts',
        '!src/scripts/index.ts',
      ],
      project: [
        'src/**/*.{js,jsx,ts,tsx,css}',
        '!src/scripts/**', // Scripts are entry points, not project files
        '*.{js,mjs,ts,tsx}',
      ],
    },
    storybook: {
      entry: [
        'stories/**/*.stories.@(ts|tsx)',
        'src/**/*.{ts,tsx}', // Storybook-specific decorators and utilities
      ],
      project: [
        '**/*.{ts,tsx,js,jsx}',
        // Exclude parent project patterns that storybook's tsconfig includes but shouldn't analyze
        '!../{src/scripts,supabase}/**',
      ],
      ignoreDependencies: [
        // Used by Chromatic GitHub Action, not directly imported in code
        '@chromatic-com/storybook',
      ],
    },
    'cloud-agent': {
      entry: ['src/index.ts', 'test/**/*.test.ts'],
      ignoreDependencies: ['cloudflare', '@vitest/coverage-v8'],
    },
    'cloudflare-ai-attribution': {
      entry: ['src/ai-attribution.worker.ts'],
      ignoreDependencies: ['cloudflare'],
    },
    'cloudflare-app-builder': {
      entry: ['src/index.ts'],
      ignoreDependencies: ['cloudflare'],
    },
    'cloudflare-auto-fix-infra': {
      entry: ['src/index.ts'],
      ignoreDependencies: ['cloudflare'],
    },
    'cloudflare-auto-triage-infra': {
      entry: ['src/index.ts'],
      ignoreDependencies: ['cloudflare'],
    },
    'cloudflare-code-review-infra': {
      entry: ['src/index.ts'],
      ignoreDependencies: ['cloudflare'],
    },
    'cloudflare-db-proxy': {
      entry: ['src/index.ts'],
      ignoreDependencies: ['cloudflare', '@cloudflare/vitest-pool-workers'],
    },
    'cloudflare-deploy-infra/builder': {
      entry: ['src/index.ts'],
      ignoreDependencies: ['cloudflare'],
    },
    'cloudflare-deploy-infra/dispatcher': {
      entry: ['src/index.ts'],
      ignoreBinaries: ['wrangler'],
    },
  },
};

export default config;
