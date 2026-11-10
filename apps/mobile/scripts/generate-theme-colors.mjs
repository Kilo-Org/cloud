import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = join(mobileDir, 'src', 'global.css');
/** The generated file's one owner: the writer below and the drift check read this. */
export const OUTPUT_PATH = join(mobileDir, 'src', 'lib', 'hooks', 'theme-colors.generated.ts');

// The runtime JS key names mapped to the CSS custom properties they read.
// Tile tokens and other CSS-only names are intentionally excluded: these are
// the only keys the app needs as plain color values.
export const TOKEN_KEYS = [
  ['background', '--background'],
  ['foreground', '--foreground'],
  ['primary', '--primary'],
  ['primaryForeground', '--primary-foreground'],
  ['primaryDisabled', '--primary-disabled'],
  ['secondary', '--secondary'],
  ['secondaryForeground', '--secondary-foreground'],
  ['secondaryFill', '--secondary-fill'],
  ['muted', '--muted'],
  ['mutedForeground', '--muted-foreground'],
  ['destructive', '--destructive'],
  ['destructiveForeground', '--destructive-foreground'],
  ['destructiveSolid', '--destructive-solid'],
  ['destructiveSolidForeground', '--destructive-solid-foreground'],
  ['border', '--border'],
  ['card', '--card'],
  ['selection', '--selection'],
  ['selectionForeground', '--selection-foreground'],
  ['ink2', '--ink2'],
  ['mutedSoft', '--muted-soft'],
  ['hairSoft', '--hair-soft'],
  ['controlIdle', '--control-idle'],
  ['skeletonFill', '--skeleton-fill'],
  ['ringTrack', '--ring-track'],
  ['accentSoft', '--accent-soft'],
  ['accentSoftForeground', '--accent-soft-foreground'],
  ['accentSoftTint', '--accent-soft-tint'],
  ['accentSoftTintForeground', '--accent-soft-tint-foreground'],
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
  ['rowHoney', '--row-honey'],
  ['rowGold', '--row-gold'],
  ['rowLime', '--row-lime'],
  ['rowSage', '--row-sage'],
  ['rowMoss', '--row-moss'],
  ['rowFern', '--row-fern'],
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

/**
 * Encodes a declaration value as a single-quoted string literal that holds the
 * value as data. JSON.stringify supplies the escaping for quotes, backslashes
 * and control characters; its double quotes are unescaped and single quotes
 * escaped, so the literal keeps the repository's single-quote style.
 */
function formatValueSource(value) {
  const unquote = String.raw`\"`;
  const quote = String.raw`\'`;
  const escaped = JSON.stringify(value)
    .slice(1, -1)
    .replaceAll(unquote, '"')
    .replaceAll(`'`, quote);
  return `'${escaped}'`;
}

export function formatObject(declarations) {
  const lines = TOKEN_KEYS.map(([jsKey, cssVar]) => {
    const value = declarations[cssVar];
    if (value === undefined) {
      throw new Error(`${CSS_PATH}: missing ${cssVar} declaration`);
    }
    return `  ${jsKey}: ${formatValueSource(value)},`;
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
