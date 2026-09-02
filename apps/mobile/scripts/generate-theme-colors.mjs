import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = join(mobileDir, 'src', 'global.css');
const OUTPUT_PATH = join(mobileDir, 'src', 'lib', 'hooks', 'theme-colors.generated.ts');

// The runtime JS key names mapped to the CSS custom properties they read.
// Tile tokens and other CSS-only names are intentionally excluded: these are
// the only keys the app needs as plain color values.
export const TOKEN_KEYS = [
  ['background', '--background'],
  ['foreground', '--foreground'],
  ['primary', '--primary'],
  ['primaryForeground', '--primary-foreground'],
  ['secondary', '--secondary'],
  ['secondaryForeground', '--secondary-foreground'],
  ['muted', '--muted'],
  ['mutedForeground', '--muted-foreground'],
  ['destructive', '--destructive'],
  ['destructiveForeground', '--destructive-foreground'],
  ['border', '--border'],
  ['card', '--card'],
  ['ink2', '--ink2'],
  ['mutedSoft', '--muted-soft'],
  ['hairSoft', '--hair-soft'],
  ['accentSoft', '--accent-soft'],
  ['accentSoftForeground', '--accent-soft-foreground'],
  ['good', '--good'],
  ['warn', '--warn'],
  ['warnForeground', '--warn-foreground'],
  ['info', '--info'],
  ['agentYuki', '--agent-yuki'],
  ['agentWorkclaw', '--agent-workclaw'],
  ['agentCloud', '--agent-cloud'],
  ['agentKilocode', '--agent-kilocode'],
  ['agentCoral', '--agent-coral'],
  ['agentSky', '--agent-sky'],
];

function collectDeclarations(rule) {
  const declarations = {};
  for (const node of rule.nodes ?? []) {
    if (node.type === 'decl') {
      declarations[node.prop] = normalizeColorValue(node.value);
    }
  }
  return declarations;
}

/** Reads the light and dark `:root` blocks from global.css. */
export function readThemeColors() {
  const css = readFileSync(CSS_PATH, 'utf8');
  const root = postcss.parse(css);

  const lightRule = root.nodes.find(node => node.type === 'rule' && node.selector === ':root');
  if (!lightRule) {
    throw new Error(`${CSS_PATH}: missing top-level :root block`);
  }

  const darkRule = root.nodes
    .filter(
      node =>
        node.type === 'atrule' &&
        node.name === 'media' &&
        /prefers-color-scheme\s*:\s*dark/.test(node.params)
    )
    .flatMap(media => media.nodes ?? [])
    .find(node => node.type === 'rule' && node.selector === ':root');
  if (!darkRule) {
    throw new Error(`${CSS_PATH}: missing :root block inside @media (prefers-color-scheme: dark)`);
  }

  return {
    light: collectDeclarations(lightRule),
    dark: collectDeclarations(darkRule),
  };
}

/** Uppercases hex values so the generated map matches the hand-written casing. */
function normalizeColorValue(value) {
  return value.startsWith('#') ? value.toUpperCase() : value;
}

function formatObject(declarations) {
  const lines = TOKEN_KEYS.map(([jsKey, cssVar]) => {
    const value = declarations[cssVar];
    if (value === undefined) {
      throw new Error(`${CSS_PATH}: missing ${cssVar} declaration`);
    }
    return `  ${jsKey}: '${value}',`;
  });
  return `{\n${lines.join('\n')}\n} as const;`;
}

export function generateThemeColorsSource() {
  const { light, dark } = readThemeColors();
  return [
    '// generated from src/global.css; do not edit by hand.',
    '',
    `export const lightColors = ${formatObject(light)}`,
    '',
    `export const darkColors = ${formatObject(dark)}`,
    '',
  ].join('\n');
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  writeFileSync(OUTPUT_PATH, generateThemeColorsSource());
  console.log(`Wrote ${OUTPUT_PATH}`);
}
