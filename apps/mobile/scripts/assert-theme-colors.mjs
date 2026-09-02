import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateThemeColorsSource } from './generate-theme-colors.mjs';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_PATH = join(mobileDir, 'src', 'lib', 'hooks', 'theme-colors.generated.ts');

const expected = generateThemeColorsSource();
const actual = readFileSync(GENERATED_PATH, 'utf8');

if (expected === actual) {
  console.log('Theme colors in sync with src/global.css');
  process.exit(0);
}

console.error(
  `Theme colors drifted from src/global.css. Run "node scripts/generate-theme-colors.mjs".`
);
process.exit(1);
