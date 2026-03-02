import tseslint from 'typescript-eslint';
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';

/**
 * Shared ESLint base config for all packages.
 * @param {string} tsconfigRootDir - The package's __dirname, used for TypeScript project resolution.
 */
export default function baseConfig(tsconfigRootDir) {
  return defineConfig([
    {
      ignores: ['node_modules/**', 'dist/**', '.wrangler/**'],
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
          tsconfigRootDir,
        },
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
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/consistent-type-imports': 'error',

        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        '@typescript-eslint/no-base-to-string': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-empty-object-type': 'error',
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
}
