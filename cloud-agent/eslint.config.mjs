import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'eslint/config';
import baseConfig from '@kilocode/eslint-config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  ...baseConfig(__dirname),
  // Allow table interpolators (objects with toString()) in template literals for SQL query files
  {
    files: ['src/session/queries/*.ts'],
    rules: {
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
]);
