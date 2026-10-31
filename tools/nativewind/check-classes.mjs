#!/usr/bin/env node
/**
 * Mobile patterns that go wrong in a way nothing else reports.
 *
 * Classes the compiler drops outright leave the element with no background,
 * no shadow, no alignment, and the build stays quiet. Each of those bans is
 * pinned to a compiler assertion further down, so it lifts the moment
 * react-native-css handles the value.
 *
 * Classes and markup that apply but land in the wrong place do so in one
 * writing direction only, so they stay invisible until the app is read in an
 * RTL locale.
 *
 * Formatting built by hand instead of through `@/lib/intl-cache` skips the tag
 * normalisation every other surface shares, and pins or ignores the locale.
 *
 * Usage: node tools/nativewind/check-classes.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { endOfComment, endOfQuoted, endOfQuotedOrComment } from '../lib/js-scan.mjs';
import { isTestArtifact, sourceFiles } from '../lib/source-files.mjs';

// Resolve from the app: react-native-css is the app's dependency, not the repo root's.
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const ROOT = new URL('../../', import.meta.url).pathname;
const SOURCE_DIRS = [join(ROOT, 'apps/mobile/src'), join(ROOT, 'packages/app-shared/src')];

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
 *
 * Read on first use, so importing this module reads no file.
 */
let themeTokenCache;
function themeTokens() {
  if (themeTokenCache === undefined) {
    const css = readFileSync(join(ROOT, 'apps/mobile/src/global.css'), 'utf8');
    const block = css.match(/@theme inline \{([\s\S]*?)\n\}/)?.[1];
    if (!block) {
      throw new Error('check-classes: no @theme inline block in apps/mobile/src/global.css');
    }
    const tokens = [...block.matchAll(/--color-([a-z0-9-]+):\s*var\(--/g)].map(m => m[1]);
    // Longest first so the alternation is unambiguous (`muted-soft` before `muted`).
    tokens.sort((a, b) => b.length - a.length || a.localeCompare(b));
    themeTokenCache = tokens;
  }
  return themeTokenCache;
}

/** The ban list, built once from the app's theme tokens. */
let ruleCache;
function rules() {
  ruleCache ??= [
    {
      // A `/opacity` modifier on a theme colour compiles to
      // `color-mix(in oklab, var(--color-…) n%, transparent)`. NativeWind v5
      // cannot decompose the variable, so the runtime drops the declaration and
      // the element paints nothing, with no build error. The `*-tile-bg` /
      // `*-tile-border` pairs pre-bake the alpha instead.
      pattern: new RegExp(`\\b(?:${COLOR_UTILITIES})-(?:${themeTokens().join('|')})/\\d+\\b`, 'g'),
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
    {
      // A numeric `leading-N` compiles to `calc(var(--spacing) * N)`, and the
      // runtime's line-height resolver treats that resolved length as a unitless
      // multiplier of the font size. `leading-9` on a 30px title paints a 945pt
      // line box, which pushes everything below it off the screen. An explicit
      // length is resolved as a length.
      pattern: /(?<![\w-])leading-\d+(?:\.5)?(?![\w[.-])/g,
      advice:
        'a numeric leading-N is multiplied by the font size at runtime; use an explicit length, e.g. leading-[1.25rem]',
    },
  ];
  return ruleCache;
}

/**
 * Horizontal padding on a scroll container's own `className` reaches the
 * native scroll view instead of its content, and in RTL the content is then
 * offset by the padding — measured at 0dp / 42dp on a screen that should have
 * been 21 / 21, with cards running off the trailing edge. Correct in LTR, so
 * nothing catches it until someone reads the app in Arabic, Farsi or Hebrew.
 */
const SCROLL_CONTAINERS =
  '(?:Animated\\.)?(?:ScrollView|TabScreenScrollView|FlatList|FlashList|KeyboardAwareScrollView)';
const SCROLL_TAG = new RegExp(`<(${SCROLL_CONTAINERS})\\b`, 'g');
const HORIZONTAL_PADDING = /^-?(?:p|px|pl|pr|ps|pe)-/;

/** Index of the `}` matching the `{` at `start`, skipping quoted text and comments. */
function endOfBraces(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const skipped = endOfQuotedOrComment(text, index);
    if (skipped !== -1) {
      index = skipped - 1;
      continue;
    }
    const char = text[index];
    if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return index;
    }
  }
  return -1;
}

/**
 * Index of the `>` closing the type argument list that starts at `start`
 * (`<FlashList<Row> ...>`). `=>` inside a function type does not close it,
 * `>>` closes two nested lists, and an object type keeps its braces.
 */
function endOfTypeArguments(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const skipped = endOfQuotedOrComment(text, index);
    if (skipped !== -1) {
      index = skipped - 1;
      continue;
    }
    const char = text[index];
    if (char === '<') {
      depth++;
    } else if (char === '>' && text[index - 1] !== '=') {
      if (--depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Index of the `>` closing the tag whose attributes start at `start`. A nested
 * JSX value or an arrow function keeps its braces open, so `=>` inside an
 * attribute cannot end the tag early, and a comment between attributes is
 * skipped whole.
 */
function endOfTag(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const skipped = endOfQuotedOrComment(text, index);
    if (skipped !== -1) {
      index = skipped - 1;
      continue;
    }
    const char = text[index];
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
    } else if (char === '>' && depth === 0) {
      return index;
    }
  }
  return -1;
}

/**
 * The class strings in a `className` expression: every string literal and
 * template-literal chunk, including the ones inside `${...}` and object
 * branches, so `cn('flex-1', compact && 'p-2')` reports `p-2`.
 */
function classStrings(expression) {
  const strings = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (char === '"' || char === "'") {
      const end = endOfQuoted(expression, index);
      strings.push(expression.slice(index + 1, end - 1));
      index = end;
    } else if (char === '`') {
      let end = index + 1;
      let chunk = '';
      while (end < expression.length && expression[end] !== '`') {
        if (expression[end] === '\\') {
          chunk += expression[end + 1] ?? '';
          end += 2;
        } else if (expression[end] === '$' && expression[end + 1] === '{') {
          const interpolation = endOfBraces(expression, end + 1);
          if (interpolation === -1) {
            end = expression.length;
            break;
          }
          strings.push(...classStrings(expression.slice(end + 2, interpolation)));
          chunk += ' ';
          end = interpolation + 1;
        } else {
          chunk += expression[end++];
        }
      }
      strings.push(chunk);
      index = end + 1;
    } else if (char === '/') {
      const end = endOfComment(expression, index);
      index = end === -1 ? index + 1 : end;
    } else if (char === '{') {
      const end = endOfBraces(expression, index);
      if (end === -1) {
        break;
      }
      strings.push(...classStrings(expression.slice(index + 1, end)));
      index = end + 1;
    } else {
      index++;
    }
  }
  return strings;
}

/**
 * The class strings on the element's own `className`. Attributes such as
 * `renderItem` and `ListHeaderComponent` hold nested JSX at brace depth > 0,
 * so the container's own classes are the only ones read.
 */
function ownClassStrings(attributes) {
  const strings = [];
  let depth = 0;
  for (let index = 0; index < attributes.length; index++) {
    const char = attributes[index];
    if (char === '"' || char === "'" || char === '`') {
      index = endOfQuoted(attributes, index) - 1;
    } else if (char === '/') {
      const end = endOfComment(attributes, index);
      index = end === -1 ? index : end - 1;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
    } else if (depth === 0 && attributes.startsWith('className', index)) {
      if (index > 0 && /[\w$.-]/.test(attributes[index - 1])) {
        continue;
      }
      let value = index + 'className'.length;
      while (/\s/.test(attributes[value])) {
        value++;
      }
      if (attributes[value] !== '=') {
        continue;
      }
      value++;
      while (/\s/.test(attributes[value])) {
        value++;
      }
      const quote = attributes[value];
      if (quote === '"' || quote === "'") {
        const end = endOfQuoted(attributes, value);
        strings.push(attributes.slice(value + 1, end - 1));
        index = end - 1;
      } else if (quote === '{') {
        const end = endOfBraces(attributes, value);
        if (end === -1) {
          break;
        }
        strings.push(...classStrings(attributes.slice(value + 1, end)));
        index = end;
      }
    }
  }
  return strings;
}

export function checkScrollPadding(relative, text) {
  const problems = [];
  for (const match of text.matchAll(SCROLL_TAG)) {
    let attributesStart = match.index + match[0].length;
    if (text[attributesStart] === '<') {
      const typeEnd = endOfTypeArguments(text, attributesStart);
      if (typeEnd !== -1) {
        attributesStart = typeEnd + 1;
      }
    }
    const tagEnd = endOfTag(text, attributesStart);
    if (tagEnd === -1) {
      continue;
    }
    const padding = ownClassStrings(text.slice(attributesStart, tagEnd))
      .flatMap(classes => classes.split(/\s+/))
      .filter(classes => HORIZONTAL_PADDING.test(classes));
    if (padding.length > 0) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(
        `${relative}:${line}: <${match[1]}> carries "${padding.join(' ')}" on its own className; move it to contentContainerClassName or the RTL layout offsets by it`
      );
    }
  }
  return problems;
}

/**
 * `Text` from `react-native` renders without the shared component's RTL
 * paragraph direction, so its copy stays left-aligned in Arabic, Farsi and
 * Hebrew while everything beside it mirrors. The type alone is safe — callers
 * annotate refs with `import type { Text }` or `type Text as RNText` — but a
 * runtime import renders the raw component under whatever name it takes, so an
 * alias is reported like a bare import.
 */
const RAW_TEXT_IMPORT = /import\s+(type\s*)?\{([^}]*)\}\s*from\s*'react-native'/gs;
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
  // The code surfaces — both diff rows, the highlighted runs inside them and
  // the fenced code block — name their own LTR base direction, because code
  // reads left to right in every interface language, and they nest a raw
  // `Text` run under the line's own `Text` so the run inherits the mono font.
  // The shared component's base font classes would override that font on every
  // run and its paragraph direction would flip the code in an RTL locale.
  'apps/mobile/src/components/agents/code-block.tsx',
  'apps/mobile/src/components/pr-review/diff/diff-line.tsx',
  'apps/mobile/src/components/pr-review/diff/highlight-runs.tsx',
  'apps/mobile/src/components/pr-review/diff/pr-diff-side-by-side-row.tsx',
]);

/**
 * Whether one named specifier brings the runtime component in: a bare `Text`
 * and `Text as <name>` do, while `type Text` and `type Text as <name>` are the
 * annotations callers type refs with.
 */
function importsRuntimeText(specifier) {
  const [imported] = specifier.split(/\s+as\s+/);
  return imported.trim() === 'Text' && !specifier.trim().startsWith('type ');
}

export function checkRawText(relative, text) {
  const problems = [];
  if (RAW_TEXT_EXEMPT.has(relative) || relative.endsWith('components/ui/text.tsx')) {
    return problems;
  }
  for (const match of text.matchAll(RAW_TEXT_IMPORT)) {
    // `import type { … }` types the list, so nothing in it is rendered.
    const typeOnly = match[1] !== undefined;
    const runtime =
      !typeOnly && match[2].split(',').some(specifier => importsRuntimeText(specifier));
    if (runtime) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(
        `${relative}:${line}: imports Text from 'react-native'; use @/components/ui/text so the copy follows the RTL paragraph direction`
      );
    }
  }
  return problems;
}

/**
 * Formatting built here instead of through `@/lib/intl-cache` skips the tag
 * normalisation every other surface shares — the reason a Serbian user read
 * Latin copy beside a Cyrillic month name — and pins or ignores the locale.
 * Scoped to the app: `packages/app-shared` is web's too, and its hardcoded
 * `en-US` calls are a separate decision.
 *
 * ECMA-402 lets the constructors run without `new`, so the names match both
 * forms. The no-`new` form requires its call parenthesis so a type reference
 * such as `Intl.DateTimeFormatOptions` or an `Intl.NumberFormat` annotation
 * stays out; `new Intl.X` matches on its own, parenthesis or not.
 */
const INTL_CONSTRUCTORS =
  'Collator|DateTimeFormat|DisplayNames|DurationFormat|ListFormat|Locale|NumberFormat|PluralRules|RelativeTimeFormat|Segmenter';
const DIRECT_INTL = new RegExp(
  `new\\s+Intl\\.\\w+|Intl\\.(?:${INTL_CONSTRUCTORS})\\s*\\(|\\.toLocale(?:Date|Time|)String\\s*\\(`,
  'g'
);
const DIRECT_INTL_DIR = join(ROOT, 'apps/mobile/src');
// These layouts are stringified and run in the iOS widget extension, which
// cannot import @/lib/intl-cache; they normalise the locale tag themselves.
const WIDGET_PROCESS_LAYOUTS = new Set([
  'apps/mobile/src/glanceable-ios/active-agents-widget.tsx',
  'apps/mobile/src/glanceable-ios/active-agents-live-activity.tsx',
  'apps/mobile/src/glanceable-ios/session-live-activity.tsx',
]);

export function checkDirectIntl(relative, absolute, text) {
  const problems = [];
  if (
    !absolute.startsWith(DIRECT_INTL_DIR) ||
    relative.endsWith('lib/intl-cache.ts') ||
    WIDGET_PROCESS_LAYOUTS.has(relative.replace(/^\//, ''))
  ) {
    return problems;
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
      continue;
    }
    for (const match of line.matchAll(DIRECT_INTL)) {
      problems.push(
        `${relative}:${index + 1}: "${match[0]}" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once`
      );
    }
  }
  return problems;
}

/** The ban list over one file's lines: every match of every rule. */
export function checkRules(relative, text) {
  const problems = [];
  const lines = text.split('\n');
  for (const rule of rules()) {
    for (const [index, line] of lines.entries()) {
      // A rule's own explanatory comment must not trip it.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
        continue;
      }
      for (const match of line.matchAll(rule.pattern)) {
        problems.push(`${relative}:${index + 1}: "${match[0]}" ${rule.advice}`);
      }
    }
  }
  return problems;
}

/**
 * Pin each ban to the compiler that justifies it. When react-native-css
 * starts handling one of these, its assertion fails here and the rule above
 * can go — rather than the ban outliving the bug forever.
 */
export function checkCompilerStillDropsThese() {
  const problems = [];
  let compile;
  try {
    ({ compile } = require('react-native-css/compiler'));
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    problems.push(
      `check-classes: react-native-css/compiler did not resolve (${detail}) — run pnpm install; the compiler pins cannot be verified without it`
    );
    return problems;
  }
  const firstValue = (css, options) => {
    const sheet = compile(css, options).stylesheet();
    return JSON.stringify(sheet?.s?.[0]?.[1]?.[0]?.d?.[0] ?? null);
  };

  const alignment = compile('.x { text-align: start; }').warnings();
  if (!JSON.stringify(alignment).includes('text-align')) {
    problems.push(
      'check-classes: text-align: start is no longer dropped — drop the text-start/end rule'
    );
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
    problems.push(
      `check-classes: color-mix over an @theme inline variable now compiles to ${themeOpacity} instead of a deferred colorMix — drop the theme-token opacity rule`
    );
  }

  // With `inlineVariables: false` (apps/mobile/metro.config.js) the spacing
  // scale reaches the runtime as a deferred calc inside the line-height
  // function, which multiplies the result by the font size. When the compiler
  // folds it to a length instead, this stops matching and the rule can go.
  const spacingLeading = firstValue(
    ':root { --spacing: 0.25rem; }\n.x { line-height: calc(var(--spacing) * 5); }',
    { inlineVariables: false }
  );
  if (!spacingLeading.includes('"lineHeight",[{},"calc"')) {
    problems.push(
      `check-classes: a spacing-scale line height now compiles to ${spacingLeading} instead of a deferred calc — drop the numeric leading rule`
    );
  }
  return problems;
}

/**
 * Every problem one source file has, from every rule this checker owns. The
 * problems are returned, not kept in module state, so one file's findings
 * cannot leak into the next call.
 */
export function checkSourceFile(relative, absolute, text) {
  return [
    ...checkScrollPadding(relative, text),
    ...checkRawText(relative, text),
    ...checkDirectIntl(relative, absolute, text),
    ...checkRules(relative, text),
  ];
}

/** The whole audit: every source file, then the compiler pins, then the report. */
function run() {
  const problems = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(dir, isTestArtifact)) {
      problems.push(...checkSourceFile(file.slice(ROOT.length), file, readFileSync(file, 'utf8')));
    }
  }
  problems.push(...checkCompilerStillDropsThese());

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    console.error(`\ncheck-classes: ${problems.length} problem(s)`);
    process.exit(1);
  }

  console.log('check-classes: no dropped classes, stray raw Text or hand-built formatters');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  run();
}
