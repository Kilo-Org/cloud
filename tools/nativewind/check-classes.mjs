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
 * Every rule reads the syntax tree oxc builds (tools/lib/ast.mjs): a JSX
 * attribute belongs to its own element, an import specifier is a specifier,
 * and a formatter is a call. Text that only looks like code — a comment, a
 * string, a type annotation, a nested template — is a node of its own, so it
 * can no longer desynchronise a rule or hide the call sites after it.
 *
 * Usage: node tools/nativewind/check-classes.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walk } from '../lib/ast.mjs';
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
    const css = readFileSync(join(APP_SRC, 'global.css'), 'utf8');
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
    if (node.type === 'Literal' && typeof node.value === 'string') {
      chunks.push({ start: node.start, raw: text.slice(node.start, node.end), value: node.value });
    } else if (node.type === 'TemplateElement') {
      // The node spans its delimiters; the chunk itself starts just inside.
      chunks.push({
        start: node.start + 1,
        raw: node.value.raw,
        value: node.value.cooked ?? node.value.raw,
      });
    }
  });
  return chunks;
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
        stringChunks(attribute?.value, text)
          .map(chunk => chunk.value)
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
    !absolute.startsWith(APP_SRC) ||
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

/** The ban list over one file: every match of every rule, in source order. */
export function checkRules(relative, program, text, lineOf) {
  const problems = [];
  for (const { start, raw } of stringChunks(program, text)) {
    for (const rule of rules()) {
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
  // The first line of an error: compile failures and resolution failures are
  // reported the same way, and a stack trace would bury the fixture name.
  const firstLine = error =>
    (error instanceof Error ? error.message : String(error)).split('\n')[0];

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
   * compiler's private stylesheet tree. `present` is reported separately
   * because an absent declaration is an outcome of its own: the compiler
   * stopped shipping what the ban warns about, so the runtime still paints
   * nothing and the ban still applies.
   */
  function emittedValue(css, options, property) {
    const sheet = compile(css, options).stylesheet();
    for (const entry of sheet?.s ?? []) {
      for (const rule of entry?.[1] ?? []) {
        for (const declaration of rule?.d ?? []) {
          if (declaration?.[1] === property) {
            return { present: true, value: declaration[0] };
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

  // `start` and `end` are separate rules, so each keyword is pinned on its
  // own: the compiler handling one keyword retires only that keyword's rule.
  // The check reads the warning report as text, so a change to the report's
  // shape leaves the pin holding instead of retiring the rule. The keyword is
  // matched quoted, which cannot land inside a warning sentence.
  for (const keyword of ['start', 'end']) {
    pin(`the text-align: ${keyword} fixture`, () => {
      const report = JSON.stringify(compile(`.x { text-align: ${keyword}; }`).warnings() ?? null);
      if (report.includes('text-align') && report.includes(JSON.stringify(keyword))) {
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
  ];
}

/** The whole audit: every source file, then the compiler pins, then the report. */
function run() {
  const problems = [];
  for (const dir of SOURCE_DIRS) {
    for (const entry of parseSourceTree(dir, ROOT, isTestArtifact)) {
      problems.push(...checkParsedFile(entry));
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

runIfMain(run, import.meta.url);
