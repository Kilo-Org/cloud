#!/usr/bin/env node
/**
 * Mobile patterns that go wrong in a way nothing else reports.
 *
 * Two kinds. Some are dropped outright, so the element renders with no
 * background, no shadow, no alignment, and the build stays quiet — each of
 * those bans is pinned to a compiler assertion further down, so it lifts the
 * moment react-native-css handles the value. The rest apply, but land in the
 * wrong place, and only in one writing direction.
 *
 * Usage: node tools/nativewind/check-classes.mjs
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

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

/**
 * Theme colour tokens come from the same `@theme inline` block in the app's
 * global.css that makes `bg-<token>` a class at all. Parsing it keeps the
 * rule in step with the generated theme map and global.css variables: a new
 * token such as `--color-primary-disabled` is covered the moment it lands,
 * instead of waiting for this list to be edited by hand.
 *
 * Tile tokens are kept on purpose: they pre-bake an alpha, and an `/opacity`
 * modifier on top of one is still a color-mix over a variable that NativeWind
 * drops.
 */
const THEME_TOKENS = (() => {
  const css = readFileSync(join(ROOT, 'apps/mobile/src/global.css'), 'utf8');
  const block = css.match(/@theme inline \{([\s\S]*?)\n\}/)?.[1];
  if (!block) {
    throw new Error('check-classes: no @theme inline block in apps/mobile/src/global.css');
  }
  const tokens = [...block.matchAll(/--color-([a-z0-9-]+):\s*var\(--/g)].map(m => m[1]);
  // Longest first so the alternation is unambiguous (`muted-soft` before `muted`).
  tokens.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return tokens;
})();

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
    // A `/opacity` modifier on a theme colour compiles to
    // `color-mix(in oklab, var(--color-…) n%, transparent)`. NativeWind v5
    // cannot decompose the variable, so the runtime drops the declaration and
    // the element paints nothing, with no build error. The `*-tile-bg` /
    // `*-tile-border` pairs pre-bake the alpha instead.
    pattern: new RegExp(`\\b(?:${COLOR_UTILITIES})-(?:${THEME_TOKENS.join('|')})/\\d+\\b`, 'g'),
    advice:
      'the /opacity modifier is dropped on CSS-variable theme colours; use the paired *-tile-bg / *-tile-border token or a concrete colour',
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

/**
 * Horizontal padding on a scroll container's own `className` reaches the
 * native scroll view instead of its content, and in RTL the content is then
 * offset by the padding — measured at 0dp / 42dp on a screen that should have
 * been 21 / 21, with cards running off the trailing edge. Correct in LTR, so
 * nothing catches it until someone reads the app in Arabic, Farsi or Hebrew.
 */
const SCROLL_CONTAINER_NAMES = [
  'ScrollView',
  'TabScreenScrollView',
  'FlatList',
  'FlashList',
  'KeyboardAwareScrollView',
];
const SCROLL_CONTAINERS = new RegExp(`^(?:Animated\\.)?(?:${SCROLL_CONTAINER_NAMES.join('|')})$`);
// Parsing is the expensive half of this check, and only a file that names a
// container can hold one.
const NAMES_A_CONTAINER = new RegExp(SCROLL_CONTAINER_NAMES.join('|'));
const HORIZONTAL_PADDING = /^-?(?:p|px|pl|pr|ps|pe)-/;

/**
 * Each container element in the file with the classes on its own `className`,
 * read from the JSX tree so the attribute is found at any position and with any
 * prop content around it.
 */
function scrollContainers(relative, text) {
  const source = ts.createSourceFile(
    relative,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const containers = [];
  const visit = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (SCROLL_CONTAINERS.test(tag)) {
        const className = node.attributes.properties.find(
          attribute =>
            ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'className'
        );
        // `className={cn(…)}` is not a class list this check can read.
        if (className?.initializer && ts.isStringLiteral(className.initializer)) {
          containers.push({
            tag,
            classes: className.initializer.text,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return containers;
}

function checkScrollPadding(relative, text) {
  if (!NAMES_A_CONTAINER.test(text)) {
    return;
  }
  // `contentContainerClassName` is a separate attribute, so padding on it stays
  // the recommended fix.
  for (const { tag, classes, line } of scrollContainers(relative, text)) {
    const padding = classes.split(/\s+/).filter(cls => HORIZONTAL_PADDING.test(cls));
    if (padding.length > 0) {
      fail(
        `${relative}:${line}: <${tag}> carries "${padding.join(' ')}" on its own className; move it to contentContainerClassName or the RTL layout offsets by it`
      );
    }
  }
}

/**
 * `Text` from `react-native` renders without the shared component's RTL
 * paragraph direction, so its copy stays left-aligned in Arabic, Farsi and
 * Hebrew while everything beside it mirrors. Importing it under an alias is
 * fine: `type Text as RNText` is how callers type a ref.
 */
const RAW_TEXT_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'react-native'/gs;
const RAW_TEXT_EXEMPT = new Set([
  // A hidden node measured for height. It must not inherit the shared
  // component's base font classes, or the measurement stops matching the
  // input it mirrors.
  'apps/mobile/src/components/agents/use-text-height.tsx',
  // These two build the agent's markdown HTML surface with their own computed
  // styles, and a `mobile-pure` test reaches them — importing the shared
  // component would pull @rn-primitives/slot's untransformed JSX into a node
  // environment. Both apply `withRtlWritingDirection` from the same source.
  'apps/mobile/src/components/agents/markdown-html.tsx',
  'apps/mobile/src/components/agents/markdown-html-details.tsx',
]);

function checkRawText(relative, text) {
  if (RAW_TEXT_EXEMPT.has(relative) || relative.endsWith('components/ui/text.tsx')) {
    return;
  }
  for (const match of text.matchAll(RAW_TEXT_IMPORT)) {
    const bare = match[1].split(',').some(name => name.trim() === 'Text');
    if (bare) {
      const line = text.slice(0, match.index).split('\n').length;
      fail(
        `${relative}:${line}: imports Text from 'react-native'; use @/components/ui/text so the copy follows the RTL paragraph direction`
      );
    }
  }
}

/**
 * Formatting built here instead of through `@/lib/intl-cache` skips the tag
 * normalisation every other surface shares — the reason a Serbian user read
 * Latin copy beside a Cyrillic month name — and pins or ignores the locale.
 * Scoped to the app: `packages/app-shared` is web's too, and its hardcoded
 * `en-US` calls are a separate decision.
 */
const DIRECT_INTL = /new Intl\.\w+|\.toLocale(?:Date|Time|)String\s*\(/g;
const DIRECT_INTL_DIR = join(ROOT, 'apps/mobile/src');
// These layouts are stringified and run in the iOS widget extension, which
// cannot import @/lib/intl-cache; they normalise the locale tag themselves.
const WIDGET_PROCESS_LAYOUTS = new Set([
  'apps/mobile/src/glanceable-ios/active-agents-widget.tsx',
  'apps/mobile/src/glanceable-ios/active-agents-live-activity.tsx',
  'apps/mobile/src/glanceable-ios/session-live-activity.tsx',
]);

function checkDirectIntl(relative, absolute, text) {
  if (
    !absolute.startsWith(DIRECT_INTL_DIR) ||
    relative.endsWith('lib/intl-cache.ts') ||
    WIDGET_PROCESS_LAYOUTS.has(relative.replace(/^\//, ''))
  ) {
    return;
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
      continue;
    }
    for (const match of line.matchAll(DIRECT_INTL)) {
      fail(
        `${relative}:${index + 1}: "${match[0]}" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once`
      );
    }
  }
}

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
    const relative = file.slice(ROOT.length);
    checkScrollPadding(relative, text);
    checkRawText(relative, text);
    checkDirectIntl(relative, file, text);
    const lines = text.split('\n');
    for (const rule of RULES) {
      for (const [index, line] of lines.entries()) {
        // A rule's own explanatory comment must not trip it.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
          continue;
        }
        for (const match of line.matchAll(rule.pattern)) {
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

  // A `/opacity` modifier on an `@theme inline` variable is emitted as a
  // deferred colorMix over the variable; the runtime cannot decompose it and
  // drops the declaration. When the compiler resolves it instead, this stops
  // matching and the rule above can go.
  const themeOpacity = firstValue(
    '@theme inline { --color-destructive: var(--destructive); }\n' +
      ':root { --destructive: #b0483a; }\n' +
      '.x { background-color: color-mix(in oklab, var(--color-destructive) 10%, transparent); }'
  );
  if (!themeOpacity.includes('colorMix')) {
    fail(
      `check-classes: color-mix over an @theme inline variable now compiles to ${themeOpacity} instead of a deferred colorMix — drop the theme-token opacity rule`
    );
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

console.log('check-classes: no dropped classes, stray raw Text or hand-built formatters');
