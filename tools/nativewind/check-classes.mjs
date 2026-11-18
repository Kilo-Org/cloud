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
 * A surface the contract builds from parts is read as one expression: a card
 * fill and a card radius split over a `cn()` argument, a ternary branch or a
 * template chunk are still one hand-built card, and a row divider is judged
 * together with its colour. Two rules read composition instead of classes — a
 * `Sheet` without its `SheetHeader`, and a `ScreenHeader` `titleContent` in a
 * file that does not own one.
 *
 * Formatting built by hand instead of through `@/lib/intl-cache` skips the tag
 * normalisation every other surface shares, and pins or ignores the locale.
 *
 * Every rule reads the syntax tree oxc builds (tools/lib/ast.mjs): a JSX
 * attribute belongs to its own element, an import specifier is a specifier,
 * and a formatter is a call. Text that only looks like code — a comment, a
 * string, a type annotation, a nested template — is a node of its own, so it
 * can no longer desynchronise a rule or hide the call sites after it.
 *
 * The mobile layout contract's rules are the table below: `LAYOUT_RULES` holds
 * each rule's id (the id a diagnostic and the baseline key carry), what it
 * bans, and the primitive that replaces it; `LAYOUT_ALLOWLIST` names the
 * modules that own the scale and may write those values. Those two constants
 * are the only description of the layout rules — retarget, rename or relax a
 * rule there, not in the checks that read it.
 *
 * A violation that already existed when the rules landed stays admitted by
 * `tools/nativewind/layout-baseline.json` (file path → count per rule). A file
 * may never exceed its baseline count, and an entry the file is now below is
 * reported with the line to lower or delete, so the baseline only shrinks and
 * at the end of the migration it is empty. Regenerate it with
 * `--write-layout-baseline` only after the violations themselves are gone.
 *
 * Usage: node tools/nativewind/check-classes.mjs [--write-layout-baseline]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { propertyName, unwrap, walk } from '../lib/ast.mjs';
import { runIfMain } from '../lib/entry-point.mjs';
import { isTestArtifact, parseSourceTree } from '../lib/source-files.mjs';

// Resolve from the app: react-native-css is the app's dependency, not the repo root's.
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_DIRS = [join(ROOT, 'apps/mobile/src'), join(ROOT, 'packages/app-shared/src')];

/**
 * The modules that own the layout scale, relative to `apps/mobile`: the UI
 * primitives, the two headers, and the two constant modules a screen reads its
 * geometry from. Everything else states layout with the scale.
 */
const LAYOUT_ALLOWLIST = [
  'src/components/ui/',
  'src/components/screen-header.tsx',
  'src/components/sheet-header.tsx',
  'src/lib/layout.ts',
  'src/lib/a11y/tap-target.ts',
];

/**
 * Trees the layout rules never read: the glanceable widgets and Live Activities
 * are stringified into the home-screen and lock-screen renderers, not React
 * Native views, so a layout class or a UI primitive has no meaning there.
 */
const LAYOUT_EXEMPT_TREES = ['src/glanceable-ios/', 'src/glanceable-android/'];

/**
 * The layout contract's rules. `patterns` read one class string (a `className`,
 * a `cn()` argument, a `*_CLASS` constant) and carry the offending class in the
 * diagnostic; a rule without `patterns` reads markup and names what it found.
 * `advice` is the primitive the contract names for the concern, so every
 * diagnostic points at the replacement instead of restating the ban.
 */
const LAYOUT_RULES = [
  {
    id: 'L1',
    patterns: [
      // A spacing, type-size, line-height, tracking or radius value written as
      // an arbitrary value re-decides one contract decision at one call site.
      /(?<![\w-])-?(?:p|px|py|pt|pb|ps|pe|pl|pr|m|mx|my|mt|mb|ms|me|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\[[^\]\s]+\]/g,
      // A numeric inner value is a size; a colour (`text-[#fff]`) or a variable
      // (`text-[var(--x)]`) is a different decision this rule does not own.
      /(?<![\w-])text-\[\d[^\]\s]*\]/g,
      /(?<![\w-])leading-\[[^\]\s]*px\]/g,
      /(?<![\w-])tracking-\[[^\]\s]+\]/g,
      /(?<![\w-])rounded-\[[^\]\s]+\]/g,
    ],
    advice:
      'use the spacing scale (px-4 gutter, gap-6 section gap), a Text variant, or the constants in @/lib/layout',
  },
  {
    id: 'L2',
    advice:
      'use SCREEN_BODY_CLASS from @/lib/layout (gutter px-4) for the scroll body, and leave ScreenHeader/SheetHeader their own gutter',
  },
  {
    id: 'L3',
    patterns: [/(?<![\w-])uppercase(?![\w-])/g, /(?<![\w-])tracking-(?:[a-z0-9-]+|\[[^\]\s]+\])/g],
    advice: 'use SectionHeader or Eyebrow for a section label',
  },
  {
    id: 'L4',
    advice: 'use Card, RowGroup or a row primitive for the surface',
  },
  {
    id: 'L5',
    patterns: [/(?<![\w-])text-(?:xl|2xl|3xl|4xl|5xl|6xl)(?![\w-])/g],
    advice: 'use ScreenHeader for page titles or a Text variant',
  },
  {
    id: 'L6',
    advice: 'use the layout classes or the constants in @/lib/layout',
  },
  {
    id: 'L7',
    advice: 'use RowChevron or a row primitive',
  },
  {
    id: 'L8',
    patterns: [
      // An arbitrary length pins one element's box instead of using the scale.
      // A percentage is a share of a measured frame (the only way to fill one),
      // and 0.5px/1px are the hairlines the contract names, so those pass;
      // calc()/var()/theme() re-implement the spacing scale, so they do not.
      /(?<![\w-])(?:min-h|min-w|max-h|max-w|size|h|w)-\[(?!0\.5px\]|1px\])(?:\d+(?:\.\d+)?(?:px|rem|pt)?|(?:calc|var|theme)\([^\]]*)\]/g,
    ],
    advice:
      "use the spacing scale (h-12, w-8…) or a constant from @/lib/a11y/tap-target (touch targets) / the row primitive's exported skeleton size",
  },
  {
    id: 'L9',
    advice:
      'a row divider is border-hair-soft at 0.5pt; use RowGroup/RowGroupItem/RowFrame, or border-hair-soft directly',
  },
  {
    id: 'L10',
    advice:
      'use title with titleAccessory; titleContent replaces the title node and re-spells its typography',
  },
  {
    id: 'L11',
    advice: 'render SheetHeader as the first child of every Sheet, so the sheet has its title row',
  },
  {
    id: 'L12',
    patterns: [
      // A horizontal padding or margin wider than the page gutter. The page
      // inset is one number; a call site that writes a wider one puts its
      // content on a column the rest of the app does not share — the 21pt
      // sheet-header label and 28pt empty-state paragraph the design gate read
      // as double insets both started as a class wider than the gutter.
      /(?<![\w-])-?(?:px|ps|pe|pl|pr|mx|ms|me)-(?:[5-9]|\d{2,})(?![\w.\-/])/g,
    ],
    advice:
      'a page inset is the 14pt gutter: use SCREEN_GUTTER_CLASS, or the primitive that owns its own inset (SheetHeader, ScreenHeader, the state and row primitives)',
  },
];

/** One rule from the table above, by id. */
function layoutRule(id) {
  const rule = LAYOUT_RULES.find(candidate => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`check-classes: layout rule ${id} is missing from LAYOUT_RULES`);
  }
  return rule;
}

/** One diagnostic for one rule, naming the class or prop it read. */
function layoutProblem(relative, line, id, offending) {
  return `${relative}:${line}: [${id}] "${offending}": ${layoutRule(id).advice}`;
}

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
const SCROLL_CONTAINER =
  /^(?:Animated\.)?(?:ScrollView|TabScreenScrollView|FlatList|FlashList|KeyboardAwareScrollView)$/;
const HORIZONTAL_PADDING = /^-?(?:p|px|pl|pr|ps|pe)-/;

/**
 * The class strings in one `className` value: every string literal and
 * template chunk it holds, including the ones a `${…}` or a `cn(…)` argument
 * contributes, so `cn('flex-1', compact && 'p-2')` contributes `p-2` and
 * `` `flex-1 ${wide ? 'p-6' : ''}` `` contributes `p-6`.
 *
 * Only the value of the element's own `className` is read, so an element
 * nested in `renderItem` or `ListHeaderComponent` keeps its classes to itself.
 */
function classStrings(value) {
  if (value === null || value === undefined) {
    return [];
  }
  if (value.type === 'Literal') {
    return typeof value.value === 'string' ? [value.value] : [];
  }
  const strings = [];
  walk(value, node => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      strings.push(node.value);
    } else if (node.type === 'TemplateElement') {
      strings.push(node.value.cooked ?? node.value.raw);
    }
  });
  return strings;
}

/** The source of a JSX tag's name, `ScrollView` or `Animated.ScrollView` alike. */
function tagName(node, text) {
  return text.slice(node.name.start, node.name.end);
}

export function checkScrollPadding(relative, program, text, lineOf) {
  const problems = [];
  walk(program, node => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    const name = tagName(node, text);
    if (!SCROLL_CONTAINER.test(name)) {
      return;
    }
    const attribute = node.attributes.find(
      candidate =>
        candidate.type === 'JSXAttribute' &&
        candidate.name.type === 'JSXIdentifier' &&
        candidate.name.name === 'className'
    );
    const padding = [
      ...new Set(
        classStrings(attribute?.value)
          .flatMap(classes => classes.split(/\s+/))
          .filter(classes => HORIZONTAL_PADDING.test(classes))
      ),
    ].sort();
    if (padding.length > 0) {
      const line = lineOf(node.start);
      problems.push(
        `${relative}:${line}: <${name}> carries "${padding.join(' ')}" on its own className; move it to contentContainerClassName or the RTL layout offsets by it`
      );
    }
  });
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

/** The name one import specifier brings in, as written. */
function importedName(node) {
  return node.type === 'Identifier' ? node.name : node.value;
}

export function checkRawText(relative, program, lineOf) {
  const problems = [];
  if (RAW_TEXT_EXEMPT.has(relative) || relative.endsWith('components/ui/text.tsx')) {
    return problems;
  }
  walk(program, node => {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') {
      return;
    }
    if (node.source.value !== 'react-native') {
      return;
    }
    const runtime = node.specifiers.some(
      specifier =>
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        importedName(specifier.imported) === 'Text'
    );
    if (runtime) {
      const line = lineOf(node.start);
      problems.push(
        `${relative}:${line}: imports Text from 'react-native'; use @/components/ui/text so the copy follows the RTL paragraph direction`
      );
    }
  });
  return problems;
}

/**
 * Formatting built here instead of through `@/lib/intl-cache` skips the tag
 * normalisation every other surface shares — the reason a Serbian user read
 * Latin copy beside a Cyrillic month name — and pins or ignores the locale.
 * Scoped to the app: `packages/app-shared` is web's too, and its hardcoded
 * `en-US` calls are a separate decision.
 *
 * ECMA-402 lets the constructors run without `new`, so both forms are calls
 * here. A plain call is reported through its parenthesis; a type reference
 * such as `Intl.DateTimeFormatOptions` or an `Intl.NumberFormat` annotation is
 * a type node, so there is nothing to report.
 */
const INTL_CONSTRUCTORS = new Set([
  'Collator',
  'DateTimeFormat',
  'DisplayNames',
  'DurationFormat',
  'ListFormat',
  'Locale',
  'NumberFormat',
  'PluralRules',
  'RelativeTimeFormat',
  'Segmenter',
]);
const TO_LOCALE_STRING = /^toLocale(?:Date|Time)?String$/;
const DIRECT_INTL_DIR = join(ROOT, 'apps/mobile/src');
// These layouts are stringified and run in the iOS widget extension, which
// cannot import @/lib/intl-cache; they normalise the locale tag themselves.
const WIDGET_PROCESS_LAYOUTS = new Set([
  'apps/mobile/src/glanceable-ios/active-agents-widget.tsx',
  'apps/mobile/src/glanceable-ios/active-agents-live-activity.tsx',
  'apps/mobile/src/glanceable-ios/session-live-activity.tsx',
]);

/** `object.name` from a member expression read as a plain dotted name. */
function memberName(callee) {
  if (callee.type !== 'MemberExpression' || callee.computed) {
    return null;
  }
  if (callee.property.type !== 'Identifier') {
    return null;
  }
  return {
    object: callee.object.type === 'Identifier' ? callee.object.name : null,
    name: callee.property.name,
    propertyStart: callee.property.start,
  };
}

/** The `@/lib/intl-cache` advice every hand-built formatter carries. */
function formatterProblem(relative, line, quote) {
  return `${relative}:${line}: "${quote}" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once`;
}

export function checkDirectIntl(relative, absolute, program, lineOf) {
  const problems = [];
  if (
    !absolute.startsWith(DIRECT_INTL_DIR) ||
    relative.endsWith('lib/intl-cache.ts') ||
    WIDGET_PROCESS_LAYOUTS.has(relative)
  ) {
    return problems;
  }
  walk(program, node => {
    if (node.type === 'NewExpression') {
      const member = memberName(node.callee);
      if (member?.object === 'Intl') {
        problems.push(
          formatterProblem(relative, lineOf(node.callee.start), `new Intl.${member.name}`)
        );
      }
      return;
    }
    if (node.type !== 'CallExpression') {
      return;
    }
    const member = memberName(node.callee);
    if (member === null) {
      return;
    }
    if (member.object === 'Intl' && INTL_CONSTRUCTORS.has(member.name)) {
      problems.push(formatterProblem(relative, lineOf(node.callee.start), `Intl.${member.name}(`));
    } else if (TO_LOCALE_STRING.test(member.name)) {
      problems.push(formatterProblem(relative, lineOf(member.propertyStart), `.${member.name}(`));
    }
  });
  return problems;
}

/**
 * The string literals and template chunks inside one expression, with the
 * offset each starts at. The raw source is what the class patterns read, so a
 * match maps straight back to the file's line, escapes included.
 */
function stringChunks(value, text) {
  const chunks = [];
  walk(value, node => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      chunks.push({ start: node.start, source: text.slice(node.start, node.end) });
    } else if (node.type === 'TemplateElement') {
      // The node spans its delimiters; the chunk itself starts just inside.
      chunks.push({ start: node.start + 1, source: node.value.raw });
    }
  });
  return chunks;
}

/** The string a class name can be written in on a JSX element. */
const CLASS_ATTRIBUTES = new Set(['className', 'contentContainerClassName']);

/** `SCREEN_BODY_CLASS`, `LINE_ACTION_BOX_CLASS`: a module constant of classes. */
function isClassConstant(node) {
  return node.type === 'Identifier' && /(?:^|_)CLASS$/.test(node.name);
}

/**
 * Every class string the layout rules read, grouped the way one surface is
 * written. A `className`/`contentContainerClassName` value and each `*_CLASS`
 * constant is one surface: the literals beside a `${…}`, the branches of a
 * ternary and the arguments of any `cn()` it calls all describe the same
 * element, so a card fill and a card radius split across them are still one
 * hand-built card. A `cn()` call outside those props is a surface of its own,
 * and one nested inside another surface is already part of it.
 */
function layoutGroups(program, text) {
  const groups = [];
  const covered = new Set();
  const add = (start, chunks) => {
    const fresh = chunks.filter(chunk => !covered.has(chunk.start));
    if (fresh.length === 0) {
      return;
    }
    for (const chunk of fresh) {
      covered.add(chunk.start);
    }
    groups.push({ start, chunks: fresh });
  };
  const argumentChunks = node => node.arguments.flatMap(argument => stringChunks(argument, text));

  walk(program, node => {
    if (
      node.type === 'JSXAttribute' &&
      node.name.type === 'JSXIdentifier' &&
      CLASS_ATTRIBUTES.has(node.name.name) &&
      node.value !== null
    ) {
      add(node.start, stringChunks(node.value, text));
    } else if (
      node.type === 'VariableDeclarator' &&
      isClassConstant(node.id) &&
      node.init !== null
    ) {
      add(node.start, stringChunks(node.init, text));
    }
  });
  walk(program, node => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'cn'
    ) {
      add(node.start, argumentChunks(node));
    }
  });
  return groups;
}

/**
 * A page gutter written on a scroll body other than `px-4` — or horizontal
 * padding on a `CenteredState` content container, which is the same page inset
 * inside the centered band — and any horizontal padding on a
 * `ScreenHeader`/`SheetHeader` `className`: both move the page inset the
 * contract fixed, and the header's own gutter is what the next screen lines up
 * against.
 */
const SCROLL_BODIES = new Set([
  'ScrollView',
  'TabScreenScrollView',
  'DetailScreenScrollView',
  'SheetScrollView',
  'FlashList',
  'KeyboardAwareScrollView',
]);
const CENTERED_BODIES = new Set(['CenteredState']);
const HEADER_TAGS = new Set(['ScreenHeader', 'SheetHeader']);

/**
 * The utility part of one class token, with any variant prefix removed. A
 * variant (`md:`, `landscape:`, `ios:`) selects when the utility applies, not
 * what it does, so the inset rules read the same padding a bare token writes —
 * the same way L12's lookbehind sees a variant-prefixed `px-6`.
 */
function utilityOf(token) {
  const segments = token.split(':');
  return segments[segments.length - 1].replace(/^!/, '');
}

/** True when one class token writes a horizontal page inset other than `px-4`. */
function wrongGutter(token) {
  const match = /^-?(p|px|ps|pe|pl|pr)-(.+)$/.exec(utilityOf(token));
  if (match === null) {
    return false;
  }
  return !((match[1] === 'px' || match[1] === 'p') && match[2] === '4');
}

/** True when a class token writes an all-side or horizontal padding at all. */
function anyPadding(token) {
  return /^-?(?:p|px|ps|pe|pl|pr)-/.test(utilityOf(token));
}

function checkScrollGutters(relative, program, text, lineOf) {
  const problems = [];
  walk(program, node => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    const name = tagName(node, text).replace(/^Animated\./, '');
    const gutter =
      SCROLL_BODIES.has(name) || CENTERED_BODIES.has(name)
        ? 'contentContainerClassName'
        : HEADER_TAGS.has(name)
          ? 'className'
          : null;
    if (gutter === null) {
      return;
    }
    const attribute = node.attributes.find(
      candidate =>
        candidate.type === 'JSXAttribute' &&
        candidate.name.type === 'JSXIdentifier' &&
        candidate.name.name === gutter
    );
    const tokens = [
      ...new Set(
        classStrings(attribute?.value)
          .flatMap(classes => classes.split(/\s+/))
          .filter(classes => (gutter === 'className' ? anyPadding(classes) : wrongGutter(classes)))
      ),
    ].sort();
    for (const token of tokens) {
      problems.push(
        layoutProblem(
          relative,
          lineOf(attribute.start),
          'L2',
          `${token} on <${tagName(node, text)}> ${gutter}`
        )
      );
    }
  });
  return problems;
}

/**
 * A card surface built by hand: one class expression that pairs a card fill
 * with a card radius. The row and card primitives own that pairing, so every
 * surface they replace can only drift from it. A directional radius counts — a
 * grouped list cell is the same hand-built card when only its ends round.
 */
const CARD_SURFACE = /(?<![\w-])bg-(?:secondary|card)(?![\w-])/;
const CARD_RADIUS = /(?<![\w-])rounded-(?:(?:t|b|l|r|tl|tr|bl|br)-)?(?:md|lg|xl|2xl|3xl)(?![\w-])/;

function cardSurfaceProblem(relative, group, lineOf) {
  const classes = group.chunks.map(chunk => chunk.source).join(' ');
  const surface = CARD_SURFACE.exec(classes);
  const radius = CARD_RADIUS.exec(classes);
  if (surface === null || radius === null) {
    return null;
  }
  return layoutProblem(relative, lineOf(group.start), 'L4', `${surface[0]} ${radius[0]}`);
}

/**
 * A row separator drawn as a side border in the full-strength border colour:
 * `border-b border-border` paints a divider at the wrong weight and hue, and it
 * is what a hand-built row looks like before it moves onto a row primitive.
 */
const DIVIDER_SIDE = /(?<![\w-])border-(?:b|t)(?:-(?:\d+|\[[^\]\s]+\]))?(?![\w-])/;
const DIVIDER_COLOUR = /(?<![\w-])border-border(?![\w-])/;

function dividerProblem(relative, group, lineOf) {
  const classes = group.chunks.map(chunk => chunk.source).join(' ');
  const side = DIVIDER_SIDE.exec(classes);
  if (side === null || !DIVIDER_COLOUR.test(classes)) {
    return null;
  }
  return layoutProblem(relative, lineOf(group.start), 'L9', `${side[0]} border-border`);
}

/**
 * Layout written as numbers in a `style` object — the `style` prop or any
 * `*Style` prop a list takes: the spacing, type, tracking and radius decisions
 * the classes own, re-decided per element. A value read from an inset, the
 * keyboard or a measurement (an identifier or a call, with no numeric literal
 * but `0`) is measured geometry, not a decision, and passes.
 */
const LAYOUT_STYLE_PROPERTY =
  /^(?:(?:padding|margin)(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?|gap|rowGap|columnGap|fontSize|lineHeight|letterSpacing|border(?:Top|Bottom|Start|End)?(?:Left|Right|Start|End)?Radius)$/;

/** True when the expression holds a numeric literal other than `0`. */
function hasNumericLiteral(node) {
  let found = false;
  walk(node, child => {
    if (
      !found &&
      child.type === 'Literal' &&
      typeof child.value === 'number' &&
      child.value !== 0
    ) {
      found = true;
    }
  });
  return found;
}

/** The object literals a `style` prop holds: the value, or the array entries. */
function styleObjects(value) {
  const expression = value.type === 'JSXExpressionContainer' ? value.expression : value;
  const target = unwrap(expression);
  if (target.type === 'ObjectExpression') {
    return [target];
  }
  if (target.type !== 'ArrayExpression') {
    return [];
  }
  return target.elements
    .filter(element => element !== null)
    .map(element => unwrap(element))
    .filter(element => element.type === 'ObjectExpression');
}

function checkInlineStyles(relative, program, text, lineOf) {
  const problems = [];
  walk(program, node => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    // `style` and every `*Style` prop (`contentContainerStyle`,
    // `columnWrapperStyle`, `ListHeaderComponentStyle`…) reach the same native
    // style object, so they are read the same way.
    const attribute = node.attributes.find(
      candidate =>
        candidate.type === 'JSXAttribute' &&
        candidate.name.type === 'JSXIdentifier' &&
        (candidate.name.name === 'style' || candidate.name.name.endsWith('Style'))
    );
    if (attribute?.value === undefined || attribute.value === null) {
      return;
    }
    for (const object of styleObjects(attribute.value)) {
      for (const property of object.properties) {
        const name = propertyName(property);
        if (name === null || !LAYOUT_STYLE_PROPERTY.test(name)) {
          continue;
        }
        if (!hasNumericLiteral(unwrap(property.value))) {
          continue;
        }
        const written = text.slice(property.key.start, property.value.end).replace(/\s+/g, ' ');
        problems.push(layoutProblem(relative, lineOf(property.start), 'L6', written));
      }
    }
  });
  return problems;
}

/**
 * A chevron placed straight from the icon modules instead of through
 * `RowChevron`, which is what mirrors it in RTL and keeps it to the row's
 * trailing size. The row primitives and `RowChevron` own that placement.
 */
const ROW_CHEVRON_MODULES = new Set(['@/components/ui/directional-icons', '@/components/ui/icons']);
const ROW_CHEVRON_NAMES = new Set(['ChevronRight', 'DirectionalChevronRight']);

function checkRowChevrons(relative, program, lineOf) {
  const problems = [];
  walk(program, node => {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') {
      return;
    }
    if (!ROW_CHEVRON_MODULES.has(node.source.value)) {
      return;
    }
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') {
        continue;
      }
      const name = importedName(specifier.imported);
      if (ROW_CHEVRON_NAMES.has(name)) {
        problems.push(layoutProblem(relative, lineOf(specifier.start), 'L7', name));
      }
    }
  });
  return problems;
}

/**
 * `titleContent` replaces the title node `ScreenHeader` paints, so the caller
 * then re-spells the title's typography and line height. Only the screens whose
 * title line is not a plain string keep it; everything else passes a `title`
 * and, for a badge beside it, `titleAccessory`.
 */
const TITLE_CONTENT_ALLOWLIST = new Set([
  'apps/mobile/src/components/chat/chat-screen.tsx',
  'apps/mobile/src/components/home/home-screen.tsx',
  'apps/mobile/src/components/profiles/profile-overview-screen.tsx',
]);

function checkTitleContent(relative, program, lineOf) {
  if (TITLE_CONTENT_ALLOWLIST.has(relative)) {
    return [];
  }
  const problems = [];
  walk(program, node => {
    if (
      node.type === 'JSXAttribute' &&
      node.name.type === 'JSXIdentifier' &&
      node.name.name === 'titleContent'
    ) {
      problems.push(layoutProblem(relative, lineOf(node.start), 'L10', 'titleContent'));
    }
  });
  return problems;
}

/**
 * A sheet opened imperatively renders its own body, so nothing outside it adds
 * the title row: without `SheetHeader` it starts under the drag handle with no
 * title and no close control. The files below are the ones that own their first
 * row instead.
 */
const SHEET_MODULE = '@/components/ui/sheet';
const SHEET_ALLOWLIST = new Set([
  // A confirmation dialog with its own title and message, not a titled sheet.
  'apps/mobile/src/components/destructive-confirm-dialog.tsx',
  // The generic sheet shell: the caller supplies the child surface and its header.
  'apps/mobile/src/components/agents/session-page-sheet.tsx',
  // These three draw the todo sheets' title with `SheetTitleRow`.
  'apps/mobile/src/components/todos/save-draft-as-todo-sheet.tsx',
  'apps/mobile/src/components/todos/session-todo-link.tsx',
  'apps/mobile/src/components/todos/todo-link-session-sheet.tsx',
]);

/**
 * The components one file defines, by name, so the sheet rule can follow a
 * sheet that renders a local component owning its title row: `<Sheet><Body /></Sheet>`
 * where `Body` draws the `SheetHeader` reads as a header even though the tag is
 * outside the sheet's own JSX.
 */
function localComponents(program) {
  const components = new Map();
  walk(program, node => {
    if (node.type === 'FunctionDeclaration' && node.id !== null) {
      components.set(node.id.name, node);
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init !== null &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')
    ) {
      components.set(node.id.name, node.init);
    }
  });
  return components;
}

/** Whether one local component — or a local component it renders — draws a header. */
function localComponentDrawsHeader(name, text, components, visited) {
  const body = components.get(name);
  if (body === undefined || visited.has(name)) {
    return false;
  }
  visited.add(name);
  let header = false;
  const children = [];
  walk(body, node => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    const tag = tagName(node, text);
    if (tag === 'SheetHeader') {
      header = true;
    } else if (components.has(tag)) {
      children.push(tag);
    }
  });
  return (
    header || children.some(child => localComponentDrawsHeader(child, text, components, visited))
  );
}

function checkSheetHeader(relative, program, text, lineOf) {
  if (SHEET_ALLOWLIST.has(relative)) {
    return [];
  }
  const sheetNames = new Set();
  walk(program, node => {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') {
      return;
    }
    if (node.source.value !== SHEET_MODULE) {
      return;
    }
    for (const specifier of node.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        importedName(specifier.imported) === 'Sheet'
      ) {
        sheetNames.add(specifier.local?.name ?? importedName(specifier.imported));
      }
    }
  });
  if (sheetNames.size === 0) {
    return [];
  }
  const problems = [];
  const components = localComponents(program);
  walk(program, node => {
    if (node.type !== 'JSXElement') {
      return;
    }
    const name = tagName(node.openingElement, text);
    if (!sheetNames.has(name)) {
      return;
    }
    // The header belongs to this sheet's own subtree. A file-level flag would
    // let a second, headerless sheet pass on the first one's header; a nested
    // sheet's header must not count for the sheet that contains it either.
    const headers = [];
    const nested = [];
    const candidates = [];
    walk(node, descendant => {
      if (descendant === node) {
        return;
      }
      if (
        descendant.type === 'JSXElement' &&
        sheetNames.has(tagName(descendant.openingElement, text))
      ) {
        nested.push(descendant);
      } else if (descendant.type === 'JSXOpeningElement') {
        const tag = tagName(descendant, text);
        if (tag === 'SheetHeader') {
          headers.push(descendant.start);
        } else if (components.has(tag)) {
          candidates.push(tag);
        }
      }
    });
    const header =
      headers.some(start => !nested.some(child => start > child.start && start < child.end)) ||
      // A sheet whose body is a local component (`<SessionFilterContent />`)
      // can draw its header there; follow the component it renders.
      candidates.some(candidate =>
        localComponentDrawsHeader(candidate, text, components, new Set())
      );
    if (!header) {
      problems.push(layoutProblem(relative, lineOf(node.start), 'L11', `<${name}>`));
    }
  });
  return problems;
}

/** Whether a file is one the layout contract exempts. */
function layoutExempt(path) {
  if (!path.startsWith('apps/mobile/src/')) {
    return true;
  }
  // The allowlist is written relative to `apps/mobile`, so it reads `src/…`.
  const appPath = path.slice('apps/mobile/'.length);
  if (LAYOUT_EXEMPT_TREES.some(tree => appPath.startsWith(tree))) {
    return true;
  }
  return LAYOUT_ALLOWLIST.some(
    entry => appPath === entry || (entry.endsWith('/') && appPath.startsWith(entry))
  );
}

/** Every layout problem one file has, from the table's rules. */
export function checkLayout(relative, program, text, lineOf) {
  if (layoutExempt(relative)) {
    return [];
  }
  const problems = [];
  const seen = new Set();
  for (const group of layoutGroups(program, text)) {
    for (const chunk of group.chunks) {
      if (seen.has(chunk.start)) {
        continue;
      }
      seen.add(chunk.start);
      for (const rule of LAYOUT_RULES) {
        for (const pattern of rule.patterns ?? []) {
          for (const match of chunk.source.matchAll(pattern)) {
            problems.push(
              layoutProblem(relative, lineOf(chunk.start + match.index), rule.id, match[0])
            );
          }
        }
      }
    }
    const surface = cardSurfaceProblem(relative, group, lineOf);
    if (surface !== null) {
      problems.push(surface);
    }
    const divider = dividerProblem(relative, group, lineOf);
    if (divider !== null) {
      problems.push(divider);
    }
  }
  problems.push(...checkScrollGutters(relative, program, text, lineOf));
  problems.push(...checkInlineStyles(relative, program, text, lineOf));
  problems.push(...checkRowChevrons(relative, program, lineOf));
  problems.push(...checkTitleContent(relative, program, lineOf));
  problems.push(...checkSheetHeader(relative, program, text, lineOf));
  return problems;
}

/**
 * The raw source of every string literal and template chunk in one file, with
 * the offset it starts at. These are the only places a class name can be
 * written: a comment, a regular expression and an identifier are nodes of
 * their own, so a ban can no longer fire on text that only reads like a class.
 *
 * The raw source is what the rules read, so a match's offset inside it maps
 * straight back to the file's line, escapes included.
 */
function stringSources(program, text) {
  const sources = [];
  walk(program, node => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      sources.push({ start: node.start, source: text.slice(node.start, node.end) });
    } else if (node.type === 'TemplateElement') {
      // The node spans its delimiters; the chunk itself starts just inside.
      sources.push({ start: node.start + 1, source: node.value.raw });
    }
  });
  return sources;
}

/** The ban list over one file: every match of every rule, in source order. */
export function checkRules(relative, program, text, lineOf) {
  const problems = [];
  const strings = stringSources(program, text);
  for (const rule of rules()) {
    for (const { start, source } of strings) {
      for (const match of source.matchAll(rule.pattern)) {
        problems.push(`${relative}:${lineOf(start + match.index)}: "${match[0]}" ${rule.advice}`);
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
  // The first line of an error: compile failures and resolution failures are
  // reported the same way, and a stack trace would bury the fixture name.
  const firstLine = error =>
    (error instanceof Error ? error.message : String(error)).split('\n')[0];
  let compile;
  try {
    ({ compile } = require('react-native-css/compiler'));
  } catch (error) {
    const detail = firstLine(error);
    problems.push(
      `check-classes: react-native-css/compiler did not resolve (${detail}) — run pnpm install; the compiler pins cannot be verified without it`
    );
    return problems;
  }

  /**
   * The value the compiled stylesheet emits for `property` in the fixture rule.
   *
   * Selecting by the property name the runtime receives keeps the pin on the
   * declaration the Metro transformer ships, not on one position in the
   * compiler's private stylesheet tree.
   */
  function emittedValue(css, options, property) {
    const sheet = compile(css, options).stylesheet();
    for (const entry of sheet?.s ?? []) {
      for (const rule of entry?.[1] ?? []) {
        for (const declaration of rule?.d ?? []) {
          if (declaration?.[1] === property) {
            return declaration[0];
          }
        }
      }
    }
    return undefined;
  }

  /**
   * True while the value still defers to a CSS function call `name`, which is how
   * the compiler keeps a value for the runtime instead of resolving it at build
   * time.
   */
  function defersTo(value, name) {
    return (
      Array.isArray(value) &&
      value.some(item => (Array.isArray(item) ? defersTo(item, name) : item === name))
    );
  }

  let alignment;
  try {
    alignment = compile('.x { text-align: start; }').warnings();
  } catch (error) {
    const detail = firstLine(error);
    problems.push(
      `check-classes: the compiler failed on the text-align: start fixture (${detail}) — the compiler pins cannot be verified without it`
    );
    return problems;
  }
  if (!JSON.stringify(alignment ?? null).includes('text-align')) {
    problems.push(
      'check-classes: text-align: start is no longer dropped — drop the text-start/end rule'
    );
  }

  // A `/opacity` modifier on an `@theme inline` variable is emitted as a
  // deferred colorMix over the variable; the runtime cannot decompose it and
  // drops the declaration. When the compiler resolves it instead, this stops
  // matching and the rule above can go.
  let themeOpacity;
  try {
    themeOpacity = emittedValue(
      '@theme inline { --color-destructive: var(--destructive); }\n' +
        ':root { --destructive: #b0483a; }\n' +
        '.x { background-color: color-mix(in oklab, var(--color-destructive) 10%, transparent); }',
      undefined,
      'backgroundColor'
    );
  } catch (error) {
    problems.push(
      `check-classes: the compiler failed on the color-mix over an @theme inline variable fixture (${firstLine(error)}) — the compiler pins cannot be verified without it`
    );
    return problems;
  }
  if (!defersTo(themeOpacity, 'colorMix')) {
    problems.push(
      `check-classes: color-mix over an @theme inline variable now compiles to ${JSON.stringify(themeOpacity ?? null)} instead of a deferred colorMix — drop the theme-token opacity rule`
    );
  }

  // With `inlineVariables: false` (apps/mobile/metro.config.js) the spacing
  // scale reaches the runtime as a deferred calc inside the line-height
  // function, which multiplies the result by the font size. When the compiler
  // folds it to a length instead, this stops matching and the rule can go.
  let spacingLeading;
  try {
    spacingLeading = emittedValue(
      ':root { --spacing: 0.25rem; }\n.x { line-height: calc(var(--spacing) * 5); }',
      { inlineVariables: false },
      'lineHeight'
    );
  } catch (error) {
    problems.push(
      `check-classes: the compiler failed on the spacing-scale line-height fixture (${firstLine(error)}) — the compiler pins cannot be verified without it`
    );
    return problems;
  }
  if (!defersTo(spacingLeading, 'calc')) {
    problems.push(
      `check-classes: a spacing-scale line height now compiles to ${JSON.stringify(spacingLeading ?? null)} instead of a deferred calc — drop the numeric leading rule`
    );
  }
  return problems;
}

/**
 * Every problem one parsed source file has, from every rule this checker owns.
 * The problems are returned, not kept in module state, so one file's findings
 * cannot leak into the next call.
 *
 * The entry is one `parseSourceTree` step (tools/lib/source-files.mjs): the
 * normalised `path` every exemption lookup, prefix test and diagnostic reads,
 * the absolute `file` the Intl rule scopes itself by, the `text`, the syntax
 * tree `program`, the `problems` the parser reported, and the `lineOf` lookup
 * those problems were built with, which the rules reuse so the text is scanned
 * for lines once. A file the parser refused is reported here, once: its tree is
 * empty, so leaving it out would report the file as clean.
 */
export function checkParsedFile({ file, path, text, program, lineOf, problems }) {
  return [
    ...problems,
    ...checkScrollPadding(path, program, text, lineOf),
    ...checkRawText(path, program, lineOf),
    ...checkDirectIntl(path, file, program, lineOf),
    ...checkRules(path, program, text, lineOf),
    ...checkLayout(path, program, text, lineOf),
  ];
}

/**
 * The checked-in baseline: `apps/mobile/src/…` file → the number of layout
 * violations of each rule the migration has not reached yet. It is written one
 * file per line so two independent deletions edit different lines.
 */
const LAYOUT_BASELINE_PATH = 'tools/nativewind/layout-baseline.json';
const LAYOUT_PROBLEM = /^(\S+):\d+: \[(L\d+)\] /;

/** The layout problems of one run, grouped by file and then by rule. */
function layoutFindings(problems) {
  const byFile = new Map();
  for (const problem of problems) {
    const match = LAYOUT_PROBLEM.exec(problem);
    if (match === null) {
      continue;
    }
    const [, path, id] = match;
    const byRule = byFile.get(path) ?? new Map();
    byFile.set(path, byRule);
    const findings = byRule.get(id) ?? [];
    byRule.set(id, findings);
    findings.push(problem);
  }
  return byFile;
}

/** The baseline as written, or an empty one when the file is absent. */
function readLayoutBaseline() {
  try {
    return JSON.parse(readFileSync(join(ROOT, LAYOUT_BASELINE_PATH), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/** Rewrite the baseline from this run's own counts: the migration's new floor. */
function writeLayoutBaseline(findings) {
  const entries = [...findings]
    .map(([path, byRule]) => [
      path,
      [...byRule]
        .map(([id, problems]) => [id, problems.length])
        .sort(([left], [right]) => (left < right ? -1 : 1)),
    ])
    .filter(([, rules]) => rules.length > 0)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  const body = entries
    .map(
      ([path, rules]) =>
        `  ${JSON.stringify(path)}: { ${rules.map(([id, count]) => `${JSON.stringify(id)}: ${count}`).join(', ')} }`
    )
    .join(',\n');
  writeFileSync(
    join(ROOT, LAYOUT_BASELINE_PATH),
    entries.length === 0 ? '{}\n' : `{\n${body}\n}\n`
  );
  console.log(`check-classes: wrote ${entries.length} file(s) to ${LAYOUT_BASELINE_PATH}`);
}

/**
 * Split the layout findings into the ones the baseline admits and the lines
 * that fail this run. A file may not exceed its count for a rule, and a file
 * below its count is a stale entry: printing the line to lower or delete keeps
 * the baseline shrinking instead of outliving the migration.
 */
function compareLayoutBaseline(findings, baseline) {
  const exceeded = new Set();
  const stale = [];
  for (const [path, byRule] of findings) {
    for (const [id, problems] of byRule) {
      const admitted = baseline[path]?.[id] ?? 0;
      if (problems.length > admitted) {
        exceeded.add(`${path} ${id}`);
      }
    }
  }
  for (const [path, rules] of Object.entries(baseline)) {
    for (const [id, admitted] of Object.entries(rules)) {
      const actual = findings.get(path)?.get(id)?.length ?? 0;
      if (actual > admitted) {
        continue;
      }
      if (actual < admitted) {
        stale.push(
          `${LAYOUT_BASELINE_PATH}: ${path} ${id} baseline is ${admitted} but the file now has ${actual}; ${actual === 0 ? 'delete the entry' : `lower it to ${actual}`}`
        );
      }
    }
  }

  const reported = [];
  const overCount = [];
  for (const [path, byRule] of findings) {
    for (const [id, problems] of byRule) {
      if (exceeded.has(`${path} ${id}`)) {
        reported.push(...problems);
        overCount.push(
          `${path}: ${id} now has ${problems.length} violation(s) and the baseline admits ${baseline[path]?.[id] ?? 0}; remove the new one(s)`
        );
      }
    }
  }
  return [...reported, ...overCount, ...stale];
}

/** The whole audit: every source file, then the compiler pins, then the report. */
function run() {
  const problems = [];
  for (const dir of SOURCE_DIRS) {
    for (const entry of parseSourceTree(dir, ROOT, isTestArtifact)) {
      problems.push(...checkParsedFile(entry));
    }
  }
  const findings = layoutFindings(problems);

  if (process.argv.includes('--write-layout-baseline')) {
    writeLayoutBaseline(findings);
    return;
  }

  problems.push(...checkCompilerStillDropsThese());

  const layoutProblems = compareLayoutBaseline(findings, readLayoutBaseline());
  const others = problems.filter(problem => !LAYOUT_PROBLEM.test(problem));

  if (others.length > 0 || layoutProblems.length > 0) {
    for (const problem of others) {
      console.error(problem);
    }
    for (const problem of layoutProblems) {
      console.error(problem);
    }
    console.error(`\ncheck-classes: ${others.length + layoutProblems.length} problem(s)`);
    process.exit(1);
  }

  const admitted = [...findings.values()].reduce(
    (total, byRule) => total + [...byRule.values()].reduce((sum, group) => sum + group.length, 0),
    0
  );
  console.log(
    `check-classes: no dropped classes, stray raw Text or hand-built formatters; ${admitted} layout violation(s) admitted by ${LAYOUT_BASELINE_PATH}`
  );
}

runIfMain(run, import.meta.url);
