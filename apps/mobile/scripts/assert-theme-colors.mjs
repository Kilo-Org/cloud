import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateThemeColorsSource,
  readThemeColors,
  TOKEN_KEYS,
} from './generate-theme-colors.mjs';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_PATH = join(mobileDir, 'src', 'lib', 'hooks', 'theme-colors.generated.ts');

function extractObject(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\} as const;`));
  if (!match) {
    throw new Error(`${GENERATED_PATH}: missing export const ${name}`);
  }
  const result = {};
  const linePattern = /^\s*(\w+):\s*'([^']*)',?$/gm;
  let line;
  while ((line = linePattern.exec(match[1])) !== null) {
    result[line[1]] = line[2];
  }
  return result;
}

const expected = generateThemeColorsSource();
const actual = readFileSync(GENERATED_PATH, 'utf8');

if (expected === actual) {
  console.log('Theme colors in sync with src/global.css');
  process.exit(0);
}

const { light, dark } = readThemeColors();
const disk = { light: extractObject(actual, 'lightColors'), dark: extractObject(actual, 'darkColors') };

const drift = [];
for (const [jsKey, cssVar] of TOKEN_KEYS) {
  if (disk.light[jsKey] !== light[cssVar]) {
    drift.push(`light ${jsKey}: generated '${light[cssVar]}' vs file '${disk.light[jsKey]}'`);
  }
  if (disk.dark[jsKey] !== dark[cssVar]) {
    drift.push(`dark ${jsKey}: generated '${dark[cssVar]}' vs file '${disk.dark[jsKey]}'`);
  }
}

console.error(`Theme colors drifted from src/global.css. Run "node scripts/generate-theme-colors.mjs".`);
for (const entry of drift) {
  console.error(`  - ${entry}`);
}
process.exit(1);
