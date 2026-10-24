import { readFileSync } from 'node:fs';

import { generateThemeColorsSource, OUTPUT_PATH } from './generate-theme-colors.mjs';

const expected = generateThemeColorsSource();
const actual = readFileSync(OUTPUT_PATH, 'utf8');

if (expected === actual) {
  console.log('Theme colors in sync with src/global.css');
  process.exit(0);
}

console.error(
  `Theme colors drifted from src/global.css. Run "node scripts/generate-theme-colors.mjs".`
);
process.exit(1);
