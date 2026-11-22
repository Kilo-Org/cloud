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
 * each rule's id (the id a diagnostic and the baseline key carry), the detector
 * that finds it, and the primitive that replaces it; `LAYOUT_ALLOWLIST` names
 * the modules that own the scale and may write those values. Those two
 * constants are the only description of the layout rules: `checkLayout`
 * dispatches over the table and builds each diagnostic from the entry it
 * dispatched from, so a rule's id is written once, in the table. Retarget,
 * rename or relax a rule there, not in the checks that read it.
 *
 * A violation that already existed when the rules landed stays admitted by
 * `tools/nativewind/layout-baseline.json` (file path → count per rule). A file
 * may never exceed its baseline count, and an entry the file is now below is
 * reported with the line to lower or delete, so the baseline only shrinks and
 * at the end of the migration it is empty. Regenerate it with
 * `--write-layout-baseline` only after the violations themselves are gone, and
 * the rewrite refuses a run that could not read the theme or could not read or
 * parse a walked file: those counts are short by what the run never saw.
 *
 * Usage: node tools/nativewind/check-classes.mjs [--write-layout-baseline]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { propertyName, stringLiteralValue, unwrap, walk } from '../lib/ast.mjs';
import { runIfMain } from '../lib/entry-point.mjs';
import { isTestArtifact, parseSourceTree } from '../lib/source-files.mjs';

// Resolve from the app: react-native-css is the app's dependency, not the repo root's.
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/**
 * The app's source root, built once. The walk below scans it, the theme tokens
 * come from its `global.css`, and the formatter rule scopes itself by it, so a
 * moved or renamed app root reaches all three together instead of leaving one
 * of them reading a path the walk no longer parses.
 */
const APP_SRC = join(ROOT, 'apps/mobile/src');
const SOURCE_DIRS = [APP_SRC, join(ROOT, 'packages/app-shared/src')];

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
 * Every utility that can write a page inset, with the side it moves. One table
 * so the two inset rules below cannot drift on which sides exist; each rule
 * still states its own policy on top of it.
 *
 * The family is horizontal only: a page inset is the column a screen's content
 * sits in, so `mt-6` or `py-6` moves an element's own box and is not one. The
 * all-side `p`/`m` entries are here because L2 judges them when they are not
 * the `p-4` gutter; L12 leaves them out below, because it owns the side insets.
 */
const INSET_UTILITIES = new Map([
  ['p', 'all'],
  ['px', 'x'],
  ['ps', 's'],
  ['pe', 'e'],
  ['pl', 'l'],
  ['pr', 'r'],
  ['m', 'all'],
  ['mx', 'x'],
  ['ms', 's'],
  ['me', 'e'],
  ['ml', 'l'],
  ['mr', 'r'],
]);

/**
 * L12's own share of the table: the side-specific insets. The all-side `p`/`m`
 * entries are left out because L12 judges a side, and it does not own the
 * all-side policy L2 states.
 */
const L12_UTILITIES = [...INSET_UTILITIES]
  .filter(([, side]) => side !== 'all')
  .map(([utility]) => utility);

/**
 * L12's pattern, built from the table above rather than spelled again, so a
 * side added there is judged by both rules at once. A side inset at 5 or more
 * is wider than the 14pt page gutter; the lookbehind and lookahead keep it off
 * a longer utility name and off a fractional or arbitrary value.
 */
const L12_PATTERN = new RegExp(
  `(?<![\\w-])-?(?:${L12_UTILITIES.join('|')})-(?:[5-9]|\\d{2,})(?![\\w.\\-/])`,
  'g'
);

/**
 * The layout contract's rules. Each entry states one rule once: `id` (the id a
 * diagnostic and the baseline key carry) and `advice` (the primitive the
 * contract names for the concern, so every diagnostic points at the replacement
 * instead of restating the ban), plus exactly one detector:
 *
 * - `patterns` read one class string (a `className`, a `cn()` argument, a
 *   `*_CLASS` constant) and carry the offending class in the diagnostic.
 * - `detectSurface` reads one laid-out class surface: it receives the `group`
 *   holding that surface's chunks and names what it found.
 * - `detect` reads the whole file, for a rule whose ban is a shape rather than
 *   a class string, and names what it found.
 *
 * `checkLayout` calls the detector each entry carries, so the dispatch below
 * needs no rule-specific code and a rule's id exists only in the table.
 *
 * Exported for the structural test that keeps this promise: an entry without a
 * detector, a duplicated id, or a second detector on one entry fails there.
 */
export const LAYOUT_RULES = [
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
    detect: detectScrollGutters,
  },
  {
    id: 'L3',
    patterns: [/(?<![\w-])uppercase(?![\w-])/g, /(?<![\w-])tracking-(?:[a-z0-9-]+|\[[^\]\s]+\])/g],
    advice: 'use SectionHeader or Eyebrow for a section label',
  },
  {
    id: 'L4',
    detectSurface: detectCardSurface,
    advice: 'use Card, RowGroup or a row primitive for the surface',
  },
  {
    id: 'L5',
    patterns: [/(?<![\w-])text-(?:xl|2xl|3xl|4xl|5xl|6xl)(?![\w-])/g],
    advice: 'use ScreenHeader for page titles or a Text variant',
  },
  {
    id: 'L6',
    detect: detectInlineStyles,
    advice: 'use the layout classes or the constants in @/lib/layout',
  },
  {
    id: 'L7',
    detect: detectRowChevrons,
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
    detectSurface: detectDivider,
  },
  {
    id: 'L10',
    advice:
      'use title with titleAccessory; titleContent replaces the title node and re-spells its typography',
    detect: detectTitleContent,
  },
  {
    id: 'L11',
    detect: detectSheetHeader,
    advice: 'render SheetHeader as the first child of every Sheet, so the sheet has its title row',
  },
  {
    id: 'L12',
    patterns: [
      // A horizontal padding or margin wider than the page gutter. The page
      // inset is one number; a call site that writes a wider one puts its
      // content on a column the rest of the app does not share — the 21pt
      // sheet-header label and 28pt empty-state paragraph the design gate read
      // as double insets both started as a class wider than the gutter. The
      // sides come from `INSET_UTILITIES`, so a side added to that table is
      // judged here without this pattern being edited.
      L12_PATTERN,
    ],
    advice:
      'a page inset is the 14pt gutter: use SCREEN_GUTTER_CLASS, or the primitive that owns its own inset (SheetHeader, ScreenHeader, the state and row primitives)',
  },
  {
    id: 'L13',
    detect: detectStateActionButtons,
    advice:
      'fill a state\u2019s action slot with StateAction from @/components/empty-state; a Button there re-decides the state action\u2019s frame, icon spacing and 48pt floor',
  },
];

/**
 * One layout finding as data: the file it is in, the rule it breaks, the line
 * it starts at, the class or prop the rule read, and the replacement the rule
 * names. The baseline gate groups and counts these fields, so a change to the
 * printed line cannot change which finding is admitted.
 */
function layoutFinding(relative, line, rule, offending) {
  return { path: relative, ruleId: rule.id, line, offending, advice: rule.advice };
}

/** The printable line for one layout finding, built where the report is printed. */
export function layoutFindingText(finding) {
  return `${finding.path}:${finding.line}: [${finding.ruleId}] "${finding.offending}": ${finding.advice}`;
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
 * The first line of an error: compile failures, resolution failures and a
 * theme read failure are all reported the same way, and a stack trace would
 * bury the file or fixture name that says what to fix.
 */
function firstLine(error) {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

let themeTokenCache;

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
 * Read on first use, so importing this module reads no file. A moved, renamed
 * or unreadable global.css, or one without the block, does not abort the
 * audit: the failure is kept as the reason so only the one rule that needs the
 * tokens is skipped and every other finding still reaches the report.
 */
function readThemeTokens() {
  try {
    const css = readFileSync(join(APP_SRC, 'global.css'), 'utf8');
    const block = css.match(/@theme inline \{([\s\S]*?)\n\}/)?.[1];
    if (!block) {
      throw new Error('no @theme inline block');
    }
    const tokens = [...block.matchAll(/--color-([a-z0-9-]+):\s*var\(--/g)].map(m => m[1]);
    if (tokens.length === 0) {
      throw new Error('no --color token in the @theme inline block');
    }
    // Longest first so the alternation is unambiguous (`muted-soft` before `muted`).
    tokens.sort((a, b) => b.length - a.length || a.localeCompare(b));
    return { tokens, failure: null };
  } catch (error) {
    return {
      tokens: null,
      failure: `check-classes: cannot read the @theme inline tokens from apps/mobile/src/global.css (${firstLine(error)}) — the /opacity modifier rule cannot run without them and was skipped`,
    };
  }
}

/** The memoised read of the theme tokens and its failure, so one read serves the run. */
function themeTokens() {
  themeTokenCache ??= readThemeTokens();
  return themeTokenCache;
}

/**
 * The `/opacity`-on-theme-token rule, or no rule when the tokens could not be
 * read: the pattern is built from the tokens themselves, so without them it
 * would match nothing while claiming the colours were checked.
 */
function opacityRules() {
  const { tokens } = themeTokens();
  if (tokens === null) {
    return [];
  }
  return [
    {
      // A `/opacity` modifier on a theme colour compiles to
      // `color-mix(in oklab, var(--color-…) n%, transparent)`. NativeWind v5
      // cannot decompose the variable, so the runtime drops the declaration and
      // the element paints nothing, with no build error. The `*-tile-bg` /
      // `*-tile-border` pairs pre-bake the alpha instead.
      pattern: new RegExp(`\\b(?:${COLOR_UTILITIES})-(?:${tokens.join('|')})/\\d+\\b`, 'g'),
      advice:
        'the /opacity modifier is dropped on CSS-variable theme colours; use the paired *-tile-bg / *-tile-border token or a concrete colour',
    },
  ];
}

/** The ban list, built once; the theme rule joins it only when its tokens were read. */
let ruleCache;
function rules() {
  ruleCache ??= [
    ...opacityRules(),
    {
      // `text-align` only accepts auto/left/right/center/justify, so this
      // logical keyword is dropped and the text keeps its default alignment.
      // `start` and `end` are separate rules so each lifts on its own keyword.
      pattern: /\btext-start\b/g,
      advice: 'text-align: start is dropped; the shared Text handles RTL alignment already',
    },
    {
      pattern: /\btext-end\b/g,
      advice: 'text-align: end is dropped; the shared Text handles RTL alignment already',
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
 * Every JSX tag that scrolls, as bare tag names: the two RTL rules below both
 * judge one of these, so a container added here is read by both instead of
 * satisfying one rule while the other stays blind to it.
 *
 * Both defects reach the same native scroll view, which is why the inventory
 * is not split per rule. A horizontal inset on the container's own `className`
 * does not narrow its content, and in RTL the content is then offset by it, so
 * cards run off the trailing edge. Correct in LTR, so nothing catches it until
 * someone reads the app in Arabic, Farsi or Hebrew. A page gutter written on
 * the content container moves the inset the layout contract fixed instead.
 *
 * `DetailScreenScrollView` and `SheetScrollView` are wrappers: each spreads its
 * props onto a plain `ScrollView`, so a caller's `className` lands on the same
 * native view. `FlatList` takes a content container exactly like `FlashList`.
 */
const SCROLL_CONTAINERS = new Set([
  'ScrollView',
  'TabScreenScrollView',
  'DetailScreenScrollView',
  'SheetScrollView',
  'FlatList',
  'FlashList',
  'KeyboardAwareScrollView',
]);

/** A tag's name without an `Animated.` wrapper: `Animated.X` and `X` are one element. */
function bareTagName(name) {
  return name.replace(/^Animated\./, '');
}

/** The inventory's answer for one tag, with any `Animated.` wrapper removed. */
function isScrollContainer(name) {
  return SCROLL_CONTAINERS.has(bareTagName(name));
}

/**
 * Every string chunk one syntax tree holds, with where each chunk starts in
 * the source text and the two readings of its content. These are the only
 * places a class name can be written: a comment, a regular expression and an
 * identifier are nodes of their own, so a ban can no longer fire on text that
 * only reads like a class.
 *
 * Each chunk is read two ways, and which reading a rule takes is the rule's
 * choice:
 * - `raw` is the chunk's source text — a string literal keeps its quotes —
 *   so a match's offset inside it maps straight back to the file's line,
 *   escapes included. The ban-list rules match on this.
 * - `value` is the string the code evaluates to (`cooked ?? raw` for a
 *   template chunk), so an escaped literal reads as its class name. The
 *   scroll-padding rule reads this.
 */
function stringChunks(root, text) {
  const chunks = [];
  walk(root, node => {
    const chunk = chunkOf(node, text);
    if (chunk !== null) {
      chunks.push(chunk);
    }
  });
  return chunks;
}

/**
 * The string chunk one node holds, or null when it holds none: a string
 * `Literal`, or a `TemplateElement`, whose node spans its delimiters so the
 * chunk itself starts just inside.
 */
function chunkOf(node, text) {
  if (node.type === 'Literal') {
    const value = stringLiteralValue(node);
    return value === null
      ? null
      : { start: node.start, raw: text.slice(node.start, node.end), value };
  }
  if (node.type === 'TemplateElement') {
    return {
      start: node.start + 1,
      raw: node.value.raw,
      value: node.value.cooked ?? node.value.raw,
    };
  }
  return null;
}

/** The source of a JSX tag's name, `ScrollView` or `Animated.ScrollView` alike. */
function tagName(node, text) {
  return text.slice(node.name.start, node.name.end);
}

/**
 * The chunks whose `start` lies inside `node`, or none when there is no node.
 * Chunk starts are strictly ascending, because the walk visits children in
 * source order and a chunk is a leaf, so the run is found with a binary search
 * instead of a second traversal: the walk of the node alone would select the
 * same chunks, and a class name reads the same either way.
 */
function chunksWithin(chunks, node) {
  if (node === null || node === undefined) {
    return [];
  }
  let low = 0;
  let high = chunks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (chunks[mid].start < node.start) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const found = [];
  for (let index = low; index < chunks.length && chunks[index].start < node.end; index++) {
    found.push(chunks[index]);
  }
  return found;
}

/** Whether one JSX node is the plain attribute named `name`. */
function isJsxAttributeNamed(node, name) {
  return (
    node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && node.name.name === name
  );
}

/**
 * The class tokens one element writes through the attribute `name`, deduped
 * and sorted: the attribute lookup, the chunk split and the per-token filter
 * that both RTL rules below share. A rule supplies only what it judges — which
 * attribute it reads and the predicate that marks a token as its violation.
 *
 * The chunks are the file's own (`fileFacts`), searched by position, so the
 * value a rule reads is the same one whether the element is the whole file or
 * came from an earlier walk.
 */
function classTokens(chunks, element, name, isBanned) {
  const attribute = element.attributes.find(candidate => isJsxAttributeNamed(candidate, name));
  const tokens = [
    ...new Set(
      chunksWithin(chunks, attribute?.value)
        .map(chunk => chunk.value)
        .flatMap(classes => classes.split(/\s+/))
        .filter(isBanned)
    ),
  ].sort();
  return { attribute, tokens };
}

export function checkScrollPadding(relative, elements, chunks, text, lineOf) {
  const problems = [];
  for (const node of elements) {
    const name = tagName(node, text);
    if (!isScrollContainer(name)) {
      continue;
    }
    const { tokens: padding } = classTokens(chunks, node, 'className', anyPadding);
    if (padding.length > 0) {
      const line = lineOf(node.start);
      problems.push(
        `${relative}:${line}: <${name}> carries "${padding.join(' ')}" on its own className; move it to contentContainerClassName or the RTL layout offsets by it`
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
const RAW_TEXT_EXEMPT = new Set([
  // The shared component itself: it is the replacement the rule names, and it
  // renders the platform Text under the base classes the rule protects.
  'apps/mobile/src/components/ui/text.tsx',
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

/** The module the raw `Text` rule reads: the platform one, not the shared component. */
const RAW_TEXT_MODULES = new Set(['react-native']);

/** The name one import specifier brings in, as written. */
function importedName(node) {
  return node.type === 'Identifier' ? node.name : node.value;
}

/**
 * The value (non-type) named imports one declaration brings in from one of
 * `modules`: the declaration-level type guard and the specifier-level one are
 * the two conditions every import rule needs, so they live here once. A rule
 * keeps its own policy — the name it bans, the line it reports, and whether it
 * keeps the local alias.
 */
function* valueImportSpecifiers(declaration, modules) {
  if (declaration.type !== 'ImportDeclaration' || declaration.importKind === 'type') {
    return;
  }
  if (!modules.has(declaration.source.value)) {
    return;
  }
  for (const specifier of declaration.specifiers) {
    if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') {
      continue;
    }
    yield specifier;
  }
}

export function checkRawText(relative, imports, lineOf) {
  const problems = [];
  if (RAW_TEXT_EXEMPT.has(relative)) {
    return problems;
  }
  for (const node of imports) {
    // One diagnostic per declaration, as before: the rule names the import, and
    // one declaration cannot be fixed twice.
    const runtime = [...valueImportSpecifiers(node, RAW_TEXT_MODULES)].some(
      specifier => importedName(specifier.imported) === 'Text'
    );
    if (runtime) {
      const line = lineOf(node.start);
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

export function checkDirectIntl(relative, absolute, calls, lineOf) {
  const problems = [];
  if (
    !absolute.startsWith(APP_SRC) ||
    relative.endsWith('lib/intl-cache.ts') ||
    WIDGET_PROCESS_LAYOUTS.has(relative)
  ) {
    return problems;
  }
  for (const node of calls) {
    if (node.type === 'NewExpression') {
      const member = memberName(node.callee);
      if (member?.object === 'Intl') {
        problems.push(
          formatterProblem(relative, lineOf(node.callee.start), `new Intl.${member.name}`)
        );
      }
      continue;
    }
    const member = memberName(node.callee);
    if (member === null) {
      continue;
    }
    if (member.object === 'Intl' && INTL_CONSTRUCTORS.has(member.name)) {
      problems.push(formatterProblem(relative, lineOf(node.callee.start), `Intl.${member.name}(`));
    } else if (TO_LOCALE_STRING.test(member.name)) {
      problems.push(formatterProblem(relative, lineOf(member.propertyStart), `.${member.name}(`));
    }
  }
  return problems;
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
 * The container each rule's page-inset check reads. A scroll container is
 * judged on its content container, because that is what carries the page
 * inset; a `CenteredState` applies the class to its content box for the same
 * reason, and a `ScreenHeader`/`SheetHeader` is the page inset itself, so its
 * own `className` must not move it.
 */
const CENTERED_BODIES = new Set(['CenteredState']);
const HEADER_TAGS = new Set(['ScreenHeader', 'SheetHeader']);

/**
 * The utility part of one class token, with any variant prefix and the token's
 * leading `!` removed. A variant (`md:`, `landscape:`, `ios:`) selects when the
 * utility applies and `!` only raises its specificity, so neither changes what
 * the utility does: every rule below reads the same inset a bare token writes —
 * the same way L12's lookbehind sees a variant-prefixed `px-6`.
 * `checkScrollPadding` reads `anyPadding` for the same reason L2's header
 * policy does: a prefixed `ios:px-4` insets the surface exactly as a bare
 * `px-4` does.
 */
function utilityOf(token) {
  const segments = token.split(':');
  return segments[segments.length - 1].replace(/^!/, '');
}

/**
 * One class token read as a page inset, or null when it is not one.
 *
 * `property` is what the utility insets — a padding or a margin — and `side`
 * is the entry the token names in `INSET_UTILITIES`, so a rule states only the
 * policy it owns on top of the same parse. A negative token (`-mt-2`) parses
 * the same way: the sign only decides which direction the inset moves.
 *
 * The two inset rules read this one parse with different policies:
 * - L12 judges a side inset at 5 or more, because the page gutter is 14pt.
 * - L2 judges the page inset on a scroll content container, a `CenteredState`
 *   content container and a header's own `className`: the first two must be
 *   exactly `px-4`/`p-4`, and a header owns its own gutter, so it takes no
 *   padding at all.
 */
function parseInset(token) {
  const match = /^-?([a-z]+)-(.+)$/.exec(utilityOf(token));
  if (match === null) {
    return null;
  }
  const [, utility, value] = match;
  const side = INSET_UTILITIES.get(utility);
  if (side === undefined) {
    return null;
  }
  return { property: utility.startsWith('p') ? 'padding' : 'margin', utility, side, value };
}

/** True when one class token writes a page inset other than the `px-4`/`p-4` gutter. */
function wrongGutter(token) {
  const inset = parseInset(token);
  if (inset === null) {
    return false;
  }
  return !((inset.utility === 'px' || inset.utility === 'p') && inset.value === '4');
}

/** True when a class token writes a padding at all: the header's own gutter policy. */
function anyPadding(token) {
  return parseInset(token)?.property === 'padding';
}

/**
 * The page inset written on a surface that owns one, with L2's two policies on
 * top of the one inset family: a scroll container's content container or a
 * `CenteredState` content container must be exactly the `px-4`/`p-4` gutter
 * (any other inset there — padding or margin — moves the page column), while a
 * `ScreenHeader`/`SheetHeader` owns its own gutter, so a screen writes no
 * padding on its `className`. Both move the page inset the contract fixed, and
 * the header's own gutter is what the next screen lines up against.
 */
function detectScrollGutters({ program, chunks, text, lineOf }) {
  const problems = [];
  walk(program, node => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    // `Animated.X` and `X` are one element to every rule here, so the wrapper
    // is removed once and each lookup below reads the same bare tag.
    const name = bareTagName(tagName(node, text));
    const gutter =
      SCROLL_CONTAINERS.has(name) || CENTERED_BODIES.has(name)
        ? 'contentContainerClassName'
        : HEADER_TAGS.has(name)
          ? 'className'
          : null;
    if (gutter === null) {
      return;
    }
    const { attribute, tokens } = classTokens(chunks, node, gutter, classes =>
      gutter === 'className' ? anyPadding(classes) : wrongGutter(classes)
    );
    for (const token of tokens) {
      problems.push({
        line: lineOf(attribute.start),
        offending: `${token} on <${tagName(node, text)}> ${gutter}`,
      });
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

function detectCardSurface({ lineOf, group }) {
  const classes = group.chunks.map(chunk => chunk.value).join(' ');
  const surface = CARD_SURFACE.exec(classes);
  const radius = CARD_RADIUS.exec(classes);
  if (surface === null || radius === null) {
    return [];
  }
  return [{ line: lineOf(group.start), offending: `${surface[0]} ${radius[0]}` }];
}

/**
 * A row separator drawn as a side border in the full-strength border colour:
 * `border-b border-border` paints a divider at the wrong weight and hue, and it
 * is what a hand-built row looks like before it moves onto a row primitive.
 */
const DIVIDER_SIDE = /(?<![\w-])border-(?:b|t)(?:-(?:\d+|\[[^\]\s]+\]))?(?![\w-])/;
const DIVIDER_COLOUR = /(?<![\w-])border-border(?![\w-])/;

function detectDivider({ lineOf, group }) {
  const classes = group.chunks.map(chunk => chunk.value).join(' ');
  const side = DIVIDER_SIDE.exec(classes);
  if (side === null || !DIVIDER_COLOUR.test(classes)) {
    return [];
  }
  return [{ line: lineOf(group.start), offending: `${side[0]} border-border` }];
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

function detectInlineStyles({ program, text, lineOf }) {
  const problems = [];
  walk(program, node => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    // `style` and every `*Style` prop (`contentContainerStyle`,
    // `columnWrapperStyle`, `ListHeaderComponentStyle`…) reach the same native
    // style object, so they are read the same way, and one element may carry
    // several of them. It deliberately matches a family, `style` and any
    // `*Style` name, rather than one exact name, which is why it does not use
    // `isJsxAttributeNamed`.
    for (const attribute of node.attributes) {
      if (
        attribute.type !== 'JSXAttribute' ||
        attribute.name.type !== 'JSXIdentifier' ||
        (attribute.name.name !== 'style' && !attribute.name.name.endsWith('Style'))
      ) {
        continue;
      }
      if (attribute.value === undefined || attribute.value === null) {
        continue;
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
          problems.push({ line: lineOf(property.start), offending: written });
        }
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

function detectRowChevrons({ program, lineOf }) {
  const problems = [];
  walk(program, node => {
    for (const specifier of valueImportSpecifiers(node, ROW_CHEVRON_MODULES)) {
      const name = importedName(specifier.imported);
      if (ROW_CHEVRON_NAMES.has(name)) {
        problems.push({ line: lineOf(specifier.start), offending: name });
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

function detectTitleContent({ relative, program, lineOf }) {
  if (TITLE_CONTENT_ALLOWLIST.has(relative)) {
    return [];
  }
  const problems = [];
  walk(program, node => {
    if (!isJsxAttributeNamed(node, 'titleContent')) {
      return;
    }
    problems.push({ line: lineOf(node.start), offending: 'titleContent' });
  });
  return problems;
}

/**
 * A sheet opened imperatively renders its own body, so nothing outside it adds
 * the title row: without `SheetHeader` it starts under the drag handle with no
 * title and no close control. The files below are the ones that own their first
 * row instead. `SHEET_MODULES` is the module set the sheet rule reads.
 */
const SHEET_MODULES = new Set(['@/components/ui/sheet']);
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

function detectSheetHeader({ relative, program, text, lineOf }) {
  if (SHEET_ALLOWLIST.has(relative)) {
    return [];
  }
  const sheetNames = new Set();
  walk(program, node => {
    for (const specifier of valueImportSpecifiers(node, SHEET_MODULES)) {
      if (importedName(specifier.imported) !== 'Sheet') {
        continue;
      }
      sheetNames.add(specifier.local?.name ?? importedName(specifier.imported));
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
    // The header belongs to this sheet's own subtree: a header inside a nested
    // sheet is that sheet's, not this one's, and the same nesting rule serves
    // both a literal SheetHeader and a local component that draws one.
    const headers = [];
    const candidates = [];
    const nested = [];
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
          candidates.push({ tag, start: descendant.start });
        }
      }
    });
    const outsideNested = start => !nested.some(child => start > child.start && start < child.end);
    const header =
      headers.some(outsideNested) ||
      // A sheet whose body is a local component (`<SessionFilterContent />`)
      // can draw its header there; follow the component it renders.
      candidates.some(
        candidate =>
          outsideNested(candidate.start) &&
          localComponentDrawsHeader(candidate.tag, text, components, new Set())
      );
    if (!header) {
      problems.push({ line: lineOf(node.start), offending: `<${name}>` });
    }
  });
  return problems;
}

/**
 * A state's `action` slot is one shared control: `StateAction` owns the frame,
 * the icon spacing and the 48pt state-action floor, so a plain `Button` there
 * is the second convention the contract removed. The rule reads the `action`
 * expression, so a Button inside a caller's own wrapper counts too.
 */
const STATE_ACTION_TAGS = new Set(['EmptyState', 'QueryError']);

/** The first `Button` element inside one JSX expression, nested wrappers included. */
function stateActionButton(expression, text) {
  let found = null;
  walk(expression, node => {
    if (found !== null || node.type !== 'JSXOpeningElement') {
      return;
    }
    if (tagName(node, text) === 'Button') {
      found = node;
    }
  });
  return found;
}

function detectStateActionButtons({ program, text, lineOf }) {
  const problems = [];
  walk(program, node => {
    if (node.type !== 'JSXOpeningElement' || !STATE_ACTION_TAGS.has(tagName(node, text))) {
      return;
    }
    for (const attribute of node.attributes) {
      if (!isJsxAttributeNamed(attribute, 'action')) {
        continue;
      }
      if (attribute.value === null || attribute.value.type !== 'JSXExpressionContainer') {
        continue;
      }
      const button = stateActionButton(attribute.value.expression, text);
      if (button !== null) {
        problems.push({ line: lineOf(button.start), offending: '<Button>' });
      }
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

/**
 * Every layout finding one file has, from the table's rules, as records. The
 * printable line is built from a record only where the report is printed.
 */
export function checkLayout(relative, program, chunks, text, lineOf) {
  if (layoutExempt(relative)) {
    return [];
  }
  const problems = [];
  const records = (rule, findings) =>
    findings.map(finding => layoutFinding(relative, finding.line, rule, finding.offending));
  // Each chunk belongs to exactly one group: `layoutGroups` filters every
  // candidate through its `covered` set and records what it hands out, so this
  // dispatch reads each chunk once without a second guard of its own.
  for (const group of layoutGroups(program, text)) {
    for (const chunk of group.chunks) {
      for (const rule of LAYOUT_RULES) {
        for (const pattern of rule.patterns ?? []) {
          for (const match of chunk.value.matchAll(pattern)) {
            problems.push(
              layoutFinding(relative, lineOf(chunk.start + match.index), rule, match[0])
            );
          }
        }
      }
    }
    for (const rule of LAYOUT_RULES) {
      if (rule.detectSurface === undefined) {
        continue;
      }
      problems.push(...records(rule, rule.detectSurface({ relative, text, lineOf, group })));
    }
  }
  for (const rule of LAYOUT_RULES) {
    if (rule.detect === undefined) {
      continue;
    }
    problems.push(...records(rule, rule.detect({ relative, program, chunks, text, lineOf })));
  }
  return problems;
}

/** The ban list over one file: every match of every rule, in source order. */
export function checkRules(relative, chunks, lineOf) {
  const problems = [];
  const bans = rules();
  for (const { start, raw } of chunks) {
    for (const rule of bans) {
      for (const match of raw.matchAll(rule.pattern)) {
        problems.push({
          offset: start + match.index,
          problem: `${relative}:${lineOf(start + match.index)}: "${match[0]}" ${rule.advice}`,
        });
      }
    }
  }
  // One chunk can match several rules, so emission is sorted by offset after
  // collection: the chunk-major walk alone does not order matches inside a
  // chunk, and the docstring promises source order.
  return problems.sort((left, right) => left.offset - right.offset).map(entry => entry.problem);
}

/**
 * Pin each ban to the compiler that justifies it. When react-native-css
 * starts handling one of these, its assertion fails here and the rule above
 * can go — rather than the ban outliving the bug forever.
 */
export function checkCompilerStillDropsThese() {
  const problems = [];

  /** One compiler-pin fixture that could not compile: the pin cannot hold. */
  function compilerPinFailure(fixture, error) {
    return `check-classes: the compiler failed on ${fixture} (${firstLine(error)}) — the compiler pins cannot be verified without it`;
  }
  let compile;
  try {
    ({ compile } = require('react-native-css/compiler'));
  } catch (error) {
    problems.push(
      `check-classes: react-native-css/compiler did not resolve (${firstLine(error)}) — run pnpm install; the compiler pins cannot be verified without it`
    );
    return problems;
  }

  /**
   * Run one pin. Its check returns the problem the compiler now shows, or
   * nothing while the ban still holds. A throw belongs to this fixture alone:
   * the compiler is loaded and the fixtures share nothing, so the next one
   * still runs.
   */
  function pin(fixture, check) {
    try {
      const problem = check();
      if (problem !== undefined) {
        problems.push(problem);
      }
    } catch (error) {
      problems.push(compilerPinFailure(fixture, error));
    }
  }

  /**
   * The value the compiled stylesheet emits for `property` in the fixture rule,
   * and whether it emits that declaration at all.
   *
   * Selecting by the property name the runtime receives keeps the pin on the
   * declaration the Metro transformer ships, not on one position in the
   * compiler's private stylesheet tree. The stylesheet encodes a declaration
   * two ways — a literal value is a plain object (`{ textAlign: 'left' }`) and
   * a value kept for the runtime is a `[value, property, important]` tuple —
   * and both are read. `present` is reported separately because an absent
   * declaration is an outcome of its own: the compiler stopped shipping what
   * the ban warns about, so the runtime still paints nothing and the ban still
   * applies.
   */
  function emittedValue(css, options, property) {
    const sheet = compile(css, options).stylesheet();
    for (const entry of sheet?.s ?? []) {
      for (const rule of entry?.[1] ?? []) {
        for (const declaration of rule?.d ?? []) {
          if (declaration?.[1] === property) {
            return { present: true, value: declaration[0] };
          }
          if (
            declaration !== null &&
            typeof declaration === 'object' &&
            !Array.isArray(declaration) &&
            Object.hasOwn(declaration, property)
          ) {
            return { present: true, value: declaration[property] };
          }
        }
      }
    }
    return { present: false, value: undefined };
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

  /**
   * One pin over a declaration the compiler must keep deferring to `call`.
   * Only a present value that resolved at build time retires the ban; an
   * absent declaration reports that and keeps the rule.
   */
  function declarationPin({ subject, css, options, property, call, rule }) {
    return () => {
      const { present, value } = emittedValue(css, options, property);
      if (!present) {
        return `check-classes: ${subject} emits no ${property} declaration — the ban still applies, so keep the ${rule} rule`;
      }
      if (defersTo(value, call)) {
        return undefined;
      }
      return `check-classes: ${subject} now compiles to ${JSON.stringify(value ?? null)} instead of a deferred ${call} — drop the ${rule} rule`;
    };
  }

  // The `left` control fixture, which the runtime accepts, proves the read
  // selects a real declaration rather than an empty stylesheet. It is the
  // precondition for EVERY pin below: each one reads an emitted declaration
  // through the same read, so a read that cannot see a declaration the
  // compiler definitely emits would make every absent-declaration pin pass
  // vacuously, holding a ban nothing is checking. When the control is absent
  // the run reports that one problem and no pin runs.
  let control;
  try {
    control = emittedValue('.x { text-align: left; }', undefined, 'textAlign');
  } catch (error) {
    problems.push(compilerPinFailure('the text-align: left control fixture', error));
  }
  if (control !== undefined && !control.present) {
    problems.push(
      'check-classes: the text-align: left control fixture emits no textAlign declaration — the compiler pins cannot be verified without it'
    );
  }
  if (control?.present) {
    // Each keyword is its own rule and its own fixture. The pin reads the
    // `textAlign` declaration the Metro transformer ships, holds while the
    // compiler emits none for the keyword, and retires that keyword's rule
    // when the declaration appears.
    for (const keyword of ['start', 'end']) {
      pin(`the text-align: ${keyword} fixture`, () => {
        const { present } = emittedValue(`.x { text-align: ${keyword}; }`, undefined, 'textAlign');
        if (!present) {
          return undefined;
        }
        return `check-classes: text-align: ${keyword} is no longer dropped — drop the text-${keyword} rule`;
      });
    }

    // A `/opacity` modifier on an `@theme inline` variable is emitted as a
    // deferred colorMix over the variable; the runtime cannot decompose it and
    // drops the declaration. When the compiler resolves it instead, this stops
    // matching and the rule above can go.
    pin(
      'the color-mix over an @theme inline variable fixture',
      declarationPin({
        subject: 'color-mix over an @theme inline variable',
        css:
          '@theme inline { --color-destructive: var(--destructive); }\n' +
          ':root { --destructive: #b0483a; }\n' +
          '.x { background-color: color-mix(in oklab, var(--color-destructive) 10%, transparent); }',
        options: undefined,
        property: 'backgroundColor',
        call: 'colorMix',
        rule: 'theme-token opacity',
      })
    );

    // With `inlineVariables: false` (apps/mobile/metro.config.js) the spacing
    // scale reaches the runtime as a deferred calc inside the line-height
    // function, which multiplies the result by the font size. When the compiler
    // folds it to a length instead, this stops matching and the rule can go.
    pin(
      'the spacing-scale line-height fixture',
      declarationPin({
        subject: 'a spacing-scale line height',
        css: ':root { --spacing: 0.25rem; }\n.x { line-height: calc(var(--spacing) * 5); }',
        options: { inlineVariables: false },
        property: 'lineHeight',
        call: 'calc',
        rule: 'numeric leading',
      })
    );
  }

  return problems;
}

/**
 * The per-file facts the four syntax rules read, gathered in one traversal.
 * `walk` rebuilds and sorts a child list at every node, so four rules that
 * each walked the file paid that cost four times over, plus a fifth walk for
 * the chunks. One pre-order visit keeps every rule's output order identical: a
 * rule reports the collected nodes in source order, arm for arm with the walk
 * it used to run.
 */
function fileFacts(program, text) {
  const chunks = [];
  const elements = [];
  const imports = [];
  const calls = [];
  walk(program, node => {
    const chunk = chunkOf(node, text);
    if (chunk !== null) {
      chunks.push(chunk);
    } else if (node.type === 'JSXOpeningElement') {
      elements.push(node);
    } else if (node.type === 'ImportDeclaration') {
      imports.push(node);
    } else if (node.type === 'NewExpression' || node.type === 'CallExpression') {
      calls.push(node);
    }
  });
  return { chunks, elements, imports, calls };
}

/**
 * Every finding one parsed source file has, from every rule this checker owns,
 * kept apart by kind: `problems` are the printable lines of the rules that
 * report text, and `layout` are the layout contract's records, which the
 * baseline gate groups and counts before anything is printed. Nothing is kept
 * in module state, so one file's findings cannot leak into the next call.
 *
 * The entry is one `parseSourceTree` step (tools/lib/source-files.mjs): the
 * normalised `path` every exemption lookup, prefix test and diagnostic reads,
 * the absolute `file` the Intl rule scopes itself by, the `text`, the syntax
 * tree `program`, the `problems` the parser reported, and the `lineOf` lookup
 * those problems were built with, which the rules reuse so the text is scanned
 * for lines once. A file the parser refused is reported here, once: its tree is
 * empty, so leaving it out would report the file as clean.
 *
 * The four syntax rules read the facts one traversal gathered; only the layout
 * rules still walk the tree themselves.
 */
export function checkParsedFile({ file, path, text, program, lineOf, problems }) {
  const { chunks, elements, imports, calls } = fileFacts(program, text);
  return {
    problems: [
      ...problems,
      ...checkScrollPadding(path, elements, chunks, text, lineOf),
      ...checkRawText(path, imports, lineOf),
      ...checkDirectIntl(path, file, calls, lineOf),
      ...checkRules(path, chunks, lineOf),
    ],
    layout: checkLayout(path, program, chunks, text, lineOf),
  };
}

/**
 * The checked-in baseline: `apps/mobile/src/…` file → the number of layout
 * violations of each rule the migration has not reached yet. It is written one
 * file per line so two independent deletions edit different lines.
 */
const LAYOUT_BASELINE_PATH = 'tools/nativewind/layout-baseline.json';

/** The layout findings of one run, grouped by file and then by rule. */
function layoutFindings(findings) {
  const byFile = new Map();
  for (const finding of findings) {
    const byRule = byFile.get(finding.path) ?? new Map();
    byFile.set(finding.path, byRule);
    const group = byRule.get(finding.ruleId) ?? [];
    byRule.set(finding.ruleId, group);
    group.push(finding);
  }
  return byFile;
}

/** One parsed value is a plain object (not an array, not null). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why the parsed baseline is not one rule map per file path, or null when it
 * is. The file is checked once, where it is read, so the comparison never runs
 * over a shape that would misreport: a string count compares as neither
 * greater nor smaller than a number and silently passes every file, and a
 * top-level array has no `path` key to admit anything.
 */
function layoutBaselineFailure(baseline) {
  if (!isPlainObject(baseline)) {
    return 'the file does not hold one rule map per file path';
  }
  for (const [path, rules] of Object.entries(baseline)) {
    if (!isPlainObject(rules)) {
      return `${path} is not one rule map per file path`;
    }
    for (const [id, count] of Object.entries(rules)) {
      if (!Number.isInteger(count) || count < 0) {
        return `${path} ${id} is not a non-negative integer`;
      }
    }
  }
  return null;
}

/**
 * The baseline as written, with the reason it could not be used when it is
 * malformed. An absent file is an empty baseline, not a failure: the migration
 * may not have written one yet. A read or parse error still throws, because
 * that is an environment problem the caller reports as its own.
 *
 * A malformed shape is kept apart from the comparison instead: the check
 * reports it as an instrument problem and skips the comparison, the same way a
 * theme read failure skips only its one rule. Reporting the comparison's own
 * verdict over an unreadable shape would be a guess.
 */
function readLayoutBaseline() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(ROOT, LAYOUT_BASELINE_PATH), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { baseline: {}, failure: null };
    }
    throw error;
  }
  const failure = layoutBaselineFailure(parsed);
  if (failure !== null) {
    return {
      baseline: {},
      failure: `check-classes: cannot read the layout baseline from ${LAYOUT_BASELINE_PATH} (${failure}) — the layout baseline comparison cannot run without it and was skipped`,
    };
  }
  return { baseline: parsed, failure: null };
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
        reported.push(...problems.map(layoutFindingText));
        overCount.push(
          `${path}: ${id} now has ${problems.length} violation(s) and the baseline admits ${baseline[path]?.[id] ?? 0}; remove the new one(s)`
        );
      }
    }
  }
  return [...reported, ...overCount, ...stale];
}

/**
 * The whole audit: every source file, then the compiler pins, then the report.
 *
 * Four seams let a test drive one run without the process's own arguments or
 * files, and each replaces exactly what it names:
 * - `read` is handed to the walk in place of the filesystem.
 * - `writeBaseline` is the writer a `--write-layout-baseline` run uses (null on
 *   an ordinary run), and it receives this run's findings instead of the file.
 * - `readBaseline` supplies both the checked-in baseline for the comparison and
 *   the failure that skips it, so a run never compares against a shape it could
 *   not read.
 * - `readTheme` supplies the `@theme inline` tokens and their failure.
 */
export function run({
  read = readFileSync,
  writeBaseline = process.argv.includes('--write-layout-baseline') ? writeLayoutBaseline : null,
  readBaseline = readLayoutBaseline,
  readTheme = readThemeTokens,
} = {}) {
  // The two memos exist so one run reads the theme once, not so a later run
  // inherits an earlier one's read: seeding both from this run's reader (and
  // dropping the ban list built from the previous tokens) keeps a run's tokens
  // its own.
  themeTokenCache = readTheme();
  ruleCache = undefined;
  const problems = [];
  // The layout contract's findings as records: their counts are compared to the
  // baseline, so the printable line is built only where the report is printed.
  const layout = [];
  // The walk's own per-file lines — a refused read, a parse error — kept apart
  // from the rules' findings: no rule can report what it never read, so a run
  // holding one of these has not audited the tree it walked.
  const unaudited = [];
  const { failure: themeFailure } = themeTokens();
  for (const dir of SOURCE_DIRS) {
    for (const entry of parseSourceTree(dir, ROOT, isTestArtifact, read)) {
      unaudited.push(...entry.problems);
      const file = checkParsedFile(entry);
      problems.push(...file.problems);
      layout.push(...file.layout);
    }
  }
  const findings = layoutFindings(layout);

  if (writeBaseline) {
    // A run that could not read the theme, or a walked file it could not read
    // or parse, has not audited the tree: rewriting the baseline from it would
    // record counts short by every file the run never saw, and the migration's
    // floor would rise instead of shrink.
    if (themeFailure !== null || unaudited.length > 0) {
      if (themeFailure !== null) {
        console.error(themeFailure);
      }
      for (const problem of unaudited) {
        console.error(problem);
      }
      const count = unaudited.length + (themeFailure === null ? 0 : 1);
      console.error(`\ncheck-classes: ${count} problem(s)`);
      process.exitCode = 1;
      return;
    }
    writeBaseline(findings);
    return;
  }

  // The theme and baseline problems belong with the instrument problems: the
  // file problems print first, then what the audit could not check, then the
  // summary.
  const { baseline, failure: baselineFailure } = readBaseline();
  if (themeFailure !== null) {
    problems.push(themeFailure);
  }
  if (baselineFailure !== null) {
    problems.push(baselineFailure);
  }
  problems.push(...checkCompilerStillDropsThese());

  // A baseline that could not be read is not compared: its own failure above
  // says why, and a comparison against the empty shape would report every
  // finding as new.
  const layoutProblems = baselineFailure === null ? compareLayoutBaseline(findings, baseline) : [];

  if (problems.length > 0 || layoutProblems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    for (const problem of layoutProblems) {
      console.error(problem);
    }
    console.error(`\ncheck-classes: ${problems.length + layoutProblems.length} problem(s)`);
    // The exit status is kept while Node drains the pending writes: a forced
    // exit can lose the tail of a report piped to a slow reader.
    process.exitCode = 1;
    return;
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
