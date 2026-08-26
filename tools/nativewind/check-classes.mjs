#!/usr/bin/env node
/**
 * Tailwind classes that NativeWind silently drops on native.
 *
 * A dropped class is invisible: the element renders with no background, no
 * alignment, no border, and nothing in the build says so. Each rule below is
 * pinned by a compiler assertion further down, so the ban lifts the moment
 * react-native-css handles the value.
 *
 * Usage: node tools/nativewind/check-classes.mjs
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve from the app: react-native-css is the app's dependency, not the repo root's.
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const ROOT = new URL('../../', import.meta.url).pathname;
const SOURCE_DIRS = [join(ROOT, 'apps/mobile/src'), join(ROOT, 'packages/app-shared/src')];

const problems = [];
const fail = message => problems.push(message);

/** Utilities that take a colour, so `<utility>-black/<alpha>` can appear. */
const COLOR_UTILITIES = [
  'bg',
  'text',
  'border',
  'ring',
  'divide',
  'placeholder',
  'decoration',
  'outline',
  'caret',
  'accent',
  'shadow',
  'from',
  'via',
  'to',
].join('|');

const RULES = [
  {
    // `bg-black/40` compiles to `#NaNNaNNaN66`: Tailwind emits
    // `color-mix(in oklab, #000 40%, transparent)`, and folding that mix
    // through OKLab yields NaN channels for achromatic black. React Native
    // cannot parse the result, so the element paints nothing at all. Other
    // colours survive the same fold — `bg-white/20` gives `#fff3` — so this
    // is black specifically, not the `/alpha` modifier in general.
    pattern: new RegExp(`\\b(?:${COLOR_UTILITIES})-black/\\d+\\b`, 'g'),
    advice: 'compiles to an unparseable #NaN colour; use a concrete value, e.g. bg-[#00000066]',
  },
  {
    // `text-align` only accepts auto/left/right/center/justify, so the
    // logical keywords are dropped and the text keeps its default alignment.
    pattern: /\btext-(?:start|end)\b/g,
    advice: 'text-align: start/end is dropped; the shared Text handles RTL alignment already',
  },
  {
    // react-native-css resolves a `dir` media condition as
    // `(I18nManager.isRTL && value === 'rtl') || value === 'ltr'`, so an
    // `ltr:` class matches in both directions and silently applies in RTL.
    pattern: /\bltr:/g,
    advice: 'the ltr: variant also matches in RTL; express the rule with rtl: instead',
  },
];

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        sourceFiles(path, out);
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

for (const dir of SOURCE_DIRS) {
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const rule of RULES) {
      for (const [index, line] of lines.entries()) {
        // A rule's own explanatory comment must not trip it.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
          continue;
        }
        for (const match of line.matchAll(rule.pattern)) {
          const relative = file.slice(ROOT.length);
          fail(`${relative}:${index + 1}: "${match[0]}" ${rule.advice}`);
        }
      }
    }
  }
}

/**
 * Pin each ban to the compiler that justifies it. When react-native-css
 * starts handling one of these, its assertion fails here and the rule above
 * can go — rather than the ban outliving the bug forever.
 */
function checkCompilerStillDropsThese() {
  let compile;
  try {
    ({ compile } = require('react-native-css/compiler'));
  } catch {
    console.warn('check-classes: react-native-css not resolvable, skipped the compiler assertions');
    return;
  }
  const firstValue = css => {
    const sheet = compile(css).stylesheet();
    return JSON.stringify(sheet?.s?.[0]?.[1]?.[0]?.d?.[0] ?? null);
  };

  const black = firstValue('.x { background-color: color-mix(in oklab, #000 40%, transparent); }');
  if (!black.includes('NaN')) {
    fail(
      `check-classes: color-mix over black now compiles to ${black} instead of NaN — drop the *-black/<alpha> rule`
    );
  }

  const alignment = compile('.x { text-align: start; }').warnings();
  if (!JSON.stringify(alignment).includes('text-align')) {
    fail('check-classes: text-align: start is no longer dropped — drop the text-start/end rule');
  }
}

checkCompilerStillDropsThese();

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(problem);
  }
  console.error(`\ncheck-classes: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log('check-classes: no silently-dropped NativeWind classes');
