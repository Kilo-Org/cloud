import { dirname } from 'path';
import { fileURLToPath } from 'url';
import drizzlePlugin from 'eslint-plugin-drizzle';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import tanstackQueryPlugin from '@tanstack/eslint-plugin-query';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs'],
        },
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      drizzle: drizzlePlugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: false,
        },
      ],
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
