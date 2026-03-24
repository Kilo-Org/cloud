import drizzlePlugin from 'eslint-plugin-drizzle';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import tanstackQueryPlugin from '@tanstack/eslint-plugin-query';

export default defineConfig([
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  ...tanstackQueryPlugin.configs['flat/recommended'],
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'build/**',
      'supabase/functions/**',
      'src/types/opencode.gen.ts',
      'src/lib/gastown/types/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      drizzle: drizzlePlugin,
    },
    rules: {
      'drizzle/enforce-delete-with-where': [
        'error',
        {
          drizzleObjectName: ['db', 'ctx.db'],
        },
      ],
      'drizzle/enforce-update-with-where': [
        'error',
        {
          drizzleObjectName: ['db', 'ctx.db'],
        },
      ],
    },
  },
]);
