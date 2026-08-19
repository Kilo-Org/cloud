// ESLint runs only zod-utils/no-inline-zod-schema on apps/mobile and
// apps/extension. The rule needs TypeScript type information, which oxlint's
// JS-plugin API does not provide; everything else stays on oxlint.
import zodUtils from 'eslint-plugin-zod-utils';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/__tests__/**',
      '**/*test-utils*',
      '**/*test-helpers*',
      'apps/extension/tests/**',
      'apps/extension/scripts/**',
    ],
  },
  {
    files: ['apps/mobile/src/**/*.{ts,tsx}', 'apps/extension/**/*.{ts,tsx}'],
    // Inline disable comments in these apps target oxlint rule names, which
    // ESLint reports as unknown rules; ignore inline config entirely.
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'zod-utils': zodUtils },
    rules: { 'zod-utils/no-inline-zod-schema': 'error' },
  },
];
