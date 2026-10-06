/**
 * Base rules come from @anaconda/playwright-utils; override here only when this repo needs it.
 */
import base from '@anaconda/playwright-utils/eslint';
import globals from 'globals';

export default [
  ...base,
  // The CI helper scripts run directly in Node.
  { files: ['ci/**/*.mjs'], languageOptions: { globals: globals.node } },
];
