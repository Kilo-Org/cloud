import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';
import tailwindcssPlugin from 'eslint-plugin-tailwindcss';
import drizzlePlugin from 'eslint-plugin-drizzle';
import nodePlugin from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintPluginNext from '@next/eslint-plugin-next';
import eslintPluginReactHooks from 'eslint-plugin-react-hooks';
import tanstackQueryPlugin from '@tanstack/eslint-plugin-query';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default defineConfig([
  eslintPluginNext.flatConfig.recommended,
  eslintPluginNext.flatConfig.coreWebVitals,
  ...tanstackQueryPlugin.configs['flat/recommended'],
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'build/**',
      'supabase/functions/**',
      'src/types/opencode.gen.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [eslint.configs.recommended, tseslint.configs.recommendedTypeChecked],
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
      tailwindcss: tailwindcssPlugin,
      drizzle: drizzlePlugin,
      n: nodePlugin,
      'react-hooks': eslintPluginReactHooks,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: false,
        },
      ],
      '@next/next/no-img-element': 'off',
      '@typescript-eslint/require-await': 'off', // at best a warning? A redundant async kind of does communicate what the consumer allows.
      // Disabled failing @typescript rules. We probably should fix these, but it's too big for this PR.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // This will catch files that are not properly included in the TypeScript project
      '@typescript-eslint/no-var-requires': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
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
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
]);
