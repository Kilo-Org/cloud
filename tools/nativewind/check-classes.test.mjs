import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { LAYOUT_RULES, checkParsedFile, layoutFindingText } from './check-classes.mjs';
import { parseSourceEntry } from '../lib/source-files.mjs';

// The rule cases read the repository's own files: the checker resolves the app's
// global.css token list from its own location, so nothing has to be copied. The
// probes and the CLI case need a root that mirrors the repository layout, and
// they build one.
const REPO = realpathSync(new URL('../..', import.meta.url).pathname);
const MOBILE_ROOT = join(REPO, 'apps/mobile');
const SHARED_SCANNERS = ['ast.mjs', 'entry-point.mjs', 'fs-entries.mjs', 'source-files.mjs'];

/**
 * The diagnostics of one file, straight from the checker's own export. A
 * fixture's text is passed directly, and the absolute path names the
 * repository's app tree because the Intl rule decides by it whether the
 * formatter rule applies; the shared parse entry reads nothing from that path
 * but the text it is given.
 *
 * The layout rules now return records the report formats where it prints them,
 * so this flattens them the same way: every assertion below reads the printable
 * lines, in the order the report prints them.
 */
function check(relative, text) {
  const { problems, layout } = checkParsedFile(
    parseSourceEntry(MOBILE_ROOT, REPO, join(REPO, relative), text)
  );
  return [...problems, ...layout.map(layoutFindingText)];
}

/** The diagnostics of several files, in the order they are listed. */
function checkAll(files) {
  return Object.entries(files).flatMap(([relative, text]) => check(relative, text));
}

/**
 * A root mirroring the repository layout, for the probes and the CLI case.
 *
 * `globalCss` decides the app's stylesheet: left out, the app's own
 * `apps/mobile/src/global.css` is copied, so the theme tokens resolve; a string
 * is written there instead, so a case can break the `@theme inline` block; null
 * writes no file, so a case can read the missing-file failure.
 *
 * `mkdtempSync` returns a path under the platform's symlinked temporary
 * directory on macOS (`/var` → `/private/var`), and the entry-point check
 * compares the script's real path with `process.argv[1]`, so the root is
 * canonicalised: a spawned audit then recognises itself and runs.
 */
function makeFixture(context, files, globalCss) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'check-classes-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  // Both SOURCE_DIRS entries must exist, or readdirSync throws ENOENT.
  mkdirSync(join(root, 'packages/app-shared/src'), { recursive: true });
  mkdirSync(join(root, 'tools/nativewind'), { recursive: true });
  mkdirSync(join(root, 'tools/lib'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  copyFileSync(
    new URL('./check-classes.mjs', import.meta.url),
    join(root, 'tools/nativewind/check-classes.mjs')
  );
  for (const name of SHARED_SCANNERS) {
    copyFileSync(new URL(`../lib/${name}`, import.meta.url), join(root, `tools/lib/${name}`));
  }
  const stylesheet = join(root, 'apps/mobile/src/global.css');
  mkdirSync(dirname(stylesheet), { recursive: true });
  if (globalCss === undefined) {
    copyFileSync(join(MOBILE_ROOT, 'src/global.css'), stylesheet);
  } else if (globalCss !== null) {
    writeFileSync(stylesheet, globalCss);
  }
  symlinkSync(join(MOBILE_ROOT, 'node_modules'), join(root, 'apps/mobile/node_modules'), 'dir');
  // The parser is a root dependency, resolved the way the repository resolves it.
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

/**
 * A root holding only the checker and its shared scanners: no source tree, no
 * global.css, no installed dependencies. Anything the module does beyond
 * declaring its exports fails here.
 */
function importOnlyRoot(context) {
  const root = mkdtempSync(join(tmpdir(), 'check-classes-import-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools/nativewind'), { recursive: true });
  mkdirSync(join(root, 'tools/lib'), { recursive: true });
  copyFileSync(
    new URL('./check-classes.mjs', import.meta.url),
    join(root, 'tools/nativewind/check-classes.mjs')
  );
  for (const name of SHARED_SCANNERS) {
    copyFileSync(new URL(`../lib/${name}`, import.meta.url), join(root, `tools/lib/${name}`));
  }
  // The parser resolves, because importing the checker loads it; nothing else
  // the fixture lacks, global.css and react-native-css included, may be read.
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

/** A component whose JSX body starts on line 3, one argument per line. */
function screen(...body) {
  return [
    'export function Screen() {',
    '  return (',
    ...body.map(line => `    ${line}`),
    '  );',
    '}',
  ].join('\n');
}

function screenProblems(source) {
  return check('apps/mobile/src/screen.tsx', source);
}

function expectProblem(source, expected) {
  const found = screenProblems(source);
  assert.ok(found.length > 0, `expected a problem from:\n${source}`);
  assert.match(found.join('\n'), expected);
  return found;
}

test('accepts horizontal padding on the content container', () => {
  assert.deepEqual(screenProblems(screen('<ScrollView contentContainerClassName="px-4" />')), []);
});

test('reads the container classes after an arrow-function prop', () => {
  expectProblem(
    screen('<ScrollView onScroll={() => onScroll()} className="px-4" />'),
    /screen\.tsx:3: <ScrollView> carries "px-4" on its own className/
  );
});

test('preserves container class inspection with callbacks', () => {
  expectProblem(
    screen(
      '<ScrollView onScroll={({ nativeEvent }) => nativeEvent.contentOffset.x > 0 && onScroll()} className="px-3" />'
    ),
    /screen\.tsx:3: <ScrollView> carries "px-3" on its own className/
  );
});

test('reads the container classes across attribute lines', () => {
  expectProblem(
    screen('<ScrollView', '  onScroll={() => onScroll()}', '  className="ps-2"', '/>'),
    /screen\.tsx:3: <ScrollView> carries "ps-2" on its own className/
  );
});

test('reads the container classes after a type argument', () => {
  expectProblem(
    screen('<FlatList<Row> data={rows} className="pl-2" />'),
    /screen\.tsx:3: <FlatList> carries "pl-2" on its own className/
  );
});

test('reads the container classes after an attribute comment', () => {
  expectProblem(
    screen('<ScrollView', '  // the scroll body', '  className="pr-3"', '/>'),
    /screen\.tsx:3: <ScrollView> carries "pr-3" on its own className/
  );
});

test('reads the container classes after an attribute holding a comparison', () => {
  expectProblem(
    screen('<ScrollView accessibilityLabel="a > b" className="pe-1" />'),
    /screen\.tsx:3: <ScrollView> carries "pe-1" on its own className/
  );
});

test('reads a single-quoted className', () => {
  expectProblem(
    screen("<ScrollView className='px-2' />"),
    /screen\.tsx:3: <ScrollView> carries "px-2" on its own className/
  );
});

test('reads the container classes on an Animated container', () => {
  expectProblem(
    screen('<Animated.ScrollView onScroll={() => onScroll()} className="px-2" />'),
    /screen\.tsx:3: <Animated\.ScrollView> carries "px-2" on its own className/
  );
});

test('ignores the classes of an element nested in a prop', () => {
  assert.deepEqual(
    screenProblems(
      screen(
        '<FlatList renderItem={() => <View className="px-3" />} className="flex-1" data={[]} />'
      )
    ),
    []
  );
});

test('reports only the container classes when a prop nests a padded element', () => {
  const found = expectProblem(
    screen('<FlatList renderItem={() => <View className="px-3" />} className="px-2" data={[]} />'),
    /screen\.tsx:3: <FlatList> carries "px-2" on its own className/
  );
  assert.doesNotMatch(found.join('\n'), /px-3/);
});

function themeTokens() {
  const css = readFileSync(join(MOBILE_ROOT, 'src/global.css'), 'utf8');
  const block = css.match(/@theme inline \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'global.css keeps an @theme inline block');
  return [...block.matchAll(/--color-([a-z0-9-]+):\s*var\(--/g)].map(m => m[1]);
}

test('flags all-side padding on a scroll container own className but not on contentContainerClassName', () => {
  const found = check(
    'apps/mobile/src/screen.tsx',
    'export const a = <ScrollView className="p-4" />;\n'
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /<ScrollView> carries "p-4" on its own className/);
});

test('accepts all-side padding moved to contentContainerClassName', () => {
  assert.deepEqual(
    check(
      'apps/mobile/src/screen.tsx',
      'export const a = <ScrollView contentContainerClassName="p-4" />;\n'
    ),
    []
  );
});

test('flags a variant-prefixed padding on a scroll container own className', () => {
  // A variant selects when the padding applies and `!` only raises its
  // specificity, so each of these insets the scroll view itself exactly as a
  // bare `px-4` does. The tokens come back deduped and sorted, one diagnostic
  // for the element, and the content container's own classes stay out of it.
  assert.deepEqual(
    screenProblems(
      screen(
        '<ScrollView className="ios:px-4 ios:px-4 android:pe-3 !pl-2 ios:!pr-2 flex-1" contentContainerClassName="gap-3" />'
      )
    ),
    [
      'apps/mobile/src/screen.tsx:3: <ScrollView> carries "!pl-2 android:pe-3 ios:!pr-2 ios:px-4" on its own className; move it to contentContainerClassName or the RTL layout offsets by it',
    ]
  );
});

test('reads padding from a cn() className expression on a scroll container', () => {
  const found = check(
    'apps/mobile/src/screen.tsx',
    'export const a = (\n' +
      '  <FlashList\n' +
      '    data={data}\n' +
      '    renderItem={({ item }) => <View className="px-4" />}\n' +
      "    className={cn('flex-1', selected && 'p-2')}\n" +
      '  />\n' +
      ');\n'
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /<FlashList> carries "p-2" on its own className/);
  assert.doesNotMatch(found.join('\n'), /px-4/);
});

test('reads padding from a template-literal className on a scroll container', () => {
  const found = check(
    'apps/mobile/src/screen.tsx',
    "export const a = <ScrollView className={`flex-1 px-4 ${wide ? 'p-6' : ''}`} />;\n"
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /<ScrollView> carries "p-6 px-4" on its own className/);
});

test('accepts padding on a contentContainerClassName expression', () => {
  assert.deepEqual(
    check(
      'apps/mobile/src/screen.tsx',
      "export const a = <ScrollView className=\"flex-1\" contentContainerClassName={cn('px-4', 'pt-4')} />;\n"
    ),
    []
  );
});

test('flags Intl formatters built with or without new', () => {
  const found = check(
    'apps/mobile/src/format.ts',
    "export const a = Intl.DateTimeFormat('en-US');\n" +
      "export const b = Intl.NumberFormat('en-US');\n" +
      "export const c = new Intl.DateTimeFormat('en-US');\n"
  );
  const text = found.join('\n');
  assert.match(text, /"Intl\.DateTimeFormat\(" builds its own formatter/);
  assert.match(text, /"Intl\.NumberFormat\(" builds its own formatter/);
  assert.match(text, /"new Intl\.DateTimeFormat" builds its own formatter/);
});

test('accepts Intl type references', () => {
  assert.deepEqual(
    check(
      'apps/mobile/src/format.ts',
      'export const options: Intl.DateTimeFormatOptions = {};\n' +
        'export let format: Intl.NumberFormat;\n'
    ),
    []
  );
});

// The same source checked under two paths: the app tree reports five hand-built
// formatters, so the empty result for the shared package proves the rule's
// scope rather than a broken fixture.
const INTL_SOURCE =
  "export const a = new Intl.DateTimeFormat('en-US');\n" +
  "export const b = Intl.NumberFormat('en-US');\n" +
  'export const c = value.toLocaleDateString();\n' +
  'export const d = value.toLocaleTimeString();\n' +
  'export const e = value.toLocaleString();\n';

test('flags toLocale*String calls on the app tree', () => {
  const found = check('apps/mobile/src/format.ts', INTL_SOURCE);
  assert.deepEqual(found, [
    'apps/mobile/src/format.ts:1: "new Intl.DateTimeFormat" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once',
    'apps/mobile/src/format.ts:2: "Intl.NumberFormat(" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once',
    'apps/mobile/src/format.ts:3: ".toLocaleDateString(" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once',
    'apps/mobile/src/format.ts:4: ".toLocaleTimeString(" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once',
    'apps/mobile/src/format.ts:5: ".toLocaleString(" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once',
  ]);
});

test('keeps the formatter rule out of the shared package', () => {
  assert.deepEqual(
    check('packages/app-shared/src/format.ts', INTL_SOURCE),
    [],
    'the same source reports five diagnostics under apps/mobile/src'
  );
});

test('reads padding from a typed scroll container tag', () => {
  const found = check(
    'apps/mobile/src/screen.tsx',
    'export const a = (\n' +
      '  <FlashList<Record<string, Row>>\n' +
      '    data={data}\n' +
      "    className={cn('flex-1', 'px-5')}\n" +
      '  />\n' +
      ');\n'
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /<FlashList> carries "px-5" on its own className/);
});

test('reads a typed tag past comments and object type arguments', () => {
  const found = check(
    'apps/mobile/src/screen.tsx',
    'export const a = (\n' +
      '  <FlashList<{ id: string }>\n' +
      "    // the render's tail > and a stray } stay inside the comment\n" +
      '    renderItem={({ item }) => <View className="px-4" />}\n' +
      "    className={cn('flex-1', 'p-2')}\n" +
      '  />\n' +
      ');\n'
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /<FlashList> carries "p-2" on its own className/);
  assert.doesNotMatch(found.join('\n'), /px-4/);
});

test('flags an Intl constructor without call parentheses after new', () => {
  const found = check(
    'apps/mobile/src/format.ts',
    'export const a = new Intl.DateTimeFormat;\n' +
      "export const b = new Intl.NumberFormat\n  ('en-US');\n"
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /"new Intl\.DateTimeFormat" builds its own formatter/);
  assert.match(found.join('\n'), /"new Intl\.NumberFormat" builds its own formatter/);
});

test('flags an opacity modifier on primary-disabled and hair-soft', () => {
  const found = check(
    'apps/mobile/src/panel.ts',
    'export const a = "bg-primary-disabled/50 border-hair-soft/50";\n'
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /"bg-primary-disabled\/50"/);
  assert.match(found.join('\n'), /"border-hair-soft\/50"/);
});

test('flags an opacity modifier on every theme token', () => {
  const tokens = themeTokens();
  assert.ok(tokens.includes('primary-disabled'));
  assert.ok(tokens.includes('hair-soft'));
  const body = tokens
    .map(token => `export const k_${token.replace(/-/g, '_')} = "bg-${token}/50";\n`)
    .join('');
  const found = check('apps/mobile/src/all-tokens.ts', body);
  const text = found.join('\n');
  assert.ok(found.length > 0);
  for (const token of tokens) {
    assert.match(text, new RegExp(`"bg-${token}/50"`));
  }
});

test('accepts theme tokens without an opacity modifier', () => {
  assert.deepEqual(
    check(
      'apps/mobile/src/panel.ts',
      'export const a = "bg-primary-disabled border-hair-soft bg-good-tile-bg";\n'
    ),
    []
  );
});

test('flags a runtime Text import under any name and allows the type-only forms', () => {
  const found = checkAll({
    'apps/mobile/src/bare.tsx': "import { Text } from 'react-native';\n",
    'apps/mobile/src/aliased.tsx': "import { Text as RNText } from 'react-native';\n",
    'apps/mobile/src/mixed.tsx':
      "import {\n  Pressable,\n  Text as RNText,\n  type TextStyle,\n} from 'react-native';\n",
    'apps/mobile/src/type-aliased.tsx': "import { type Text as RNText } from 'react-native';\n",
    'apps/mobile/src/type-import.tsx': "import type { Text } from 'react-native';\n",
  });
  const text = found.join('\n');
  assert.ok(found.length > 0);
  assert.match(text, /bare\.tsx:1: imports Text from 'react-native'/);
  assert.match(text, /aliased\.tsx:1: imports Text from 'react-native'/);
  assert.match(text, /mixed\.tsx:1: imports Text from 'react-native'/);
  assert.doesNotMatch(text, /type-aliased/);
  assert.doesNotMatch(text, /type-import/);
});

test('exempts the shared Text module by its own path, not by a suffix', () => {
  const source = "import { Text } from 'react-native';\n";
  assert.deepEqual(check('apps/mobile/src/components/ui/text.tsx', source), []);
  assert.match(
    check('packages/app-shared/src/components/ui/text.tsx', source).join('\n'),
    /imports Text from 'react-native'/
  );
});

test('runs the whole audit over a clean tree through the CLI and ignores test scaffolding', context => {
  // The scaffolding filter lives in the audit's file walk, not in
  // checkParsedFile, so this case runs the entry point that walks the tree.
  const root = makeFixture(context, {
    'apps/mobile/src/screen.tsx': screen('<ScrollView contentContainerClassName="px-4" />'),
    'apps/mobile/src/components/screen.mounted.test.tsx': "import { Text } from 'react-native';\n",
    'apps/mobile/src/components/screen.mounted.test-helpers.ts':
      "import { Text } from 'react-native';\n",
    'apps/mobile/src/components/screen.test.tsx': "import { Text } from 'react-native';\n",
  });
  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(
    result.stdout,
    /check-classes: no dropped classes, stray raw Text or hand-built formatters/
  );
});

test('reports an unreadable file through the CLI and keeps the findings it collected', context => {
  // The read refusal must reach the same problem list as the rules', or the
  // audit ends on a stack trace and loses every finding already collected.
  if (process.getuid?.() === 0) {
    context.skip('root reads any file, so chmod 000 leaves it readable');
    return;
  }
  const root = makeFixture(context, {
    'apps/mobile/src/bans.ts': 'const b = "text-start";\n',
    'apps/mobile/src/locked.ts': 'const c = "text-start";\n',
  });
  const locked = join(root, 'apps/mobile/src/locked.ts');
  chmodSync(locked, 0o000);
  // Restore the mode before the fixture's own cleanup runs, so removal cannot
  // trip on the mode this case set.
  try {
    const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /locked\.ts: cannot read: /);
    assert.match(result.stderr, /bans\.ts:1: "text-start"/);
    assert.match(result.stderr, /check-classes: \d+ problem\(s\)/);
    // A stack trace means the read escaped the problem list.
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    chmodSync(locked, 0o644);
  }
});

/**
 * A root whose `react-native-css` is a stub package naming the compiler entry:
 * the pins' subject is the compiler's behaviour, so a stub stands in for the
 * API drift the audit exists to catch.
 *
 * `makeFixture` links the app's node_modules to the repository's own, so the
 * stub cannot shadow one package in place. The require base walks app
 * package.json → its node_modules → root node_modules, so the fixture swaps
 * the app's link for a real directory that holds only the stub package. The
 * real package.json is resolved through Node, not a package-manager layout
 * path, so the exports map still resolves `./compiler` under any linker.
 */
function stubbedCompilerFixture(
  context,
  entrySource,
  files = { 'apps/mobile/src/bans.ts': 'const b = "text-start";\n' }
) {
  const root = makeFixture(context, files);
  const entry = join(root, 'apps/mobile/node_modules/react-native-css');
  rmSync(join(root, 'apps/mobile/node_modules'), { recursive: true, force: true });
  mkdirSync(join(entry, 'dist/commonjs/compiler'), { recursive: true });
  copyFileSync(
    // The checker resolves the compiler from the app's package.json base, so
    // this resolution names the same installed tree under any package manager.
    createRequire(join(MOBILE_ROOT, 'package.json')).resolve('react-native-css/package.json'),
    join(entry, 'package.json')
  );
  writeFileSync(join(entry, 'dist/commonjs/compiler/index.js'), entrySource);
  return root;
}

/**
 * A stylesheet still holding both declarations the bans warn about: a deferred
 * colorMix for `backgroundColor` and a deferred calc for `lineHeight`. It
 * answers every fixture that is not a text-align one, so a case that fails a
 * text-align pin leaves the other pins passing.
 */
const HOLDING_STYLESHEET =
  "{ s: [['x', [{ d: [" +
  "[['colorMix', [['color', '#b0483a'], ['percent', 10]]], 'backgroundColor'], " +
  "[['calc', [['var', ['--spacing']], '*', 5]], 'lineHeight']" +
  '] }]]] }';

/**
 * A compiler stub that answers each fixture by the CSS it receives.
 *
 * The `text-align: left` control fixture emits `{ textAlign: 'left' }` unless
 * `textAlign.left` is null: it is the literal declaration the pins' read is
 * proven against. A `start` or `end` key makes that keyword's fixture emit
 * `{ textAlign: <value> }`; an omitted keyword emits no declaration, which is
 * what its pin holds on. Every other fixture emits `stylesheet` — the holding
 * declarations by default.
 */
function compilerStub({ textAlign = {}, stylesheet = HOLDING_STYLESHEET } = {}) {
  const branches = [];
  if (textAlign.left !== null) {
    branches.push(['text-align: left', JSON.stringify('left')]);
  }
  for (const keyword of ['start', 'end']) {
    if (textAlign[keyword] !== undefined) {
      branches.push([`text-align: ${keyword}`, JSON.stringify(textAlign[keyword])]);
    }
  }
  return (
    'module.exports = {\n' +
    '  compile(css) {\n' +
    "    const run = d => ({ stylesheet() { return { s: [['x', [{ d }]]] }; } });\n" +
    branches
      .map(
        ([fixture, value]) =>
          `    if (css.includes('${fixture}')) return run([{ textAlign: ${value} }]);\n`
      )
      .join('') +
    `    return { stylesheet() { return ${stylesheet}; } };\n` +
    '  },\n' +
    '};\n'
  );
}

for (const [name, entrySource, expected, absent] of [
  [
    'will not load, which is the only failure that stops the pins',
    "throw new Error('compiler entry exploded');\n",
    ['react-native-css/compiler did not resolve (compiler entry exploded) — run pnpm install'],
    'the compiler failed on',
  ],
  [
    'throws at compile, and the one control problem is the whole report',
    "module.exports = { compile() { throw new Error('stubbed compiler exploded on line one'); } };\n",
    // The control is the precondition for every pin, so a compiler that throws
    // on it reports one problem and no pin runs: the other fixtures are never
    // compiled, which the absent fragment below pins.
    [
      'the compiler failed on the text-align: left control fixture (stubbed compiler exploded on line one)',
    ],
    [
      'the compiler failed on the color-mix over an @theme inline variable fixture',
      'the compiler failed on the spacing-scale line-height fixture',
      'color-mix over an @theme inline variable emits no',
      'a spacing-scale line height emits no',
      'drop the numeric leading rule',
    ],
  ],
  [
    'throws for the color-mix fixture only',
    // The fixture CSS is the stub's only input, so a throw it raises for one
    // fixture leaves the other pins running on the same stylesheet. The control
    // compiles, or no pin would run at all.
    [
      'module.exports = {',
      '  compile(css) {',
      "    if (css.includes('color-mix')) throw new Error('color-mix fixture exploded');",
      "    if (css.includes('text-align: left')) return runLeft();",
      '    return {',
      '      stylesheet() {',
      "        return { s: [['x', [{ d: [[['calc', [['var', ['--spacing']], '*', 5]], 'lineHeight']] }]]] };",
      '      },',
      '    };',
      '  },',
      '};',
      "function runLeft() { return { stylesheet() { return { s: [['x', [{ d: [{ textAlign: 'left' }] }]]] }; } }; }",
    ].join('\n') + '\n',
    [
      'the compiler failed on the color-mix over an @theme inline variable fixture (color-mix fixture exploded)',
    ],
    'the text-align: left control fixture emits no',
  ],
  [
    'emits textAlign for the text-align: start fixture only',
    compilerStub({ textAlign: { start: 'start' } }),
    // The control and `end` are untouched, so only the start keyword's rule is
    // retired: the pin fails when a keyword starts being honoured.
    ['text-align: start is no longer dropped — drop the text-start rule'],
    'text-align: end is no longer dropped',
  ],
  [
    'emits textAlign for both text-align keyword fixtures',
    compilerStub({ textAlign: { start: 'start', end: 'end' } }),
    [
      'text-align: start is no longer dropped — drop the text-start rule',
      'text-align: end is no longer dropped — drop the text-end rule',
    ],
  ],
  [
    'emits no textAlign for the control fixture',
    compilerStub({ textAlign: { left: null } }),
    [
      'the text-align: left control fixture emits no textAlign declaration — the compiler pins cannot be verified without it',
    ],
    'is no longer dropped',
  ],
  [
    'emits no backgroundColor declaration for the color-mix fixture',
    compilerStub({
      stylesheet: `{ s: [['x', [{ d: [[['calc', [['var', ['--spacing']], '*', 5]], 'lineHeight']] }]]] }`,
    }),
    [
      'color-mix over an @theme inline variable emits no backgroundColor declaration — the ban still applies, so keep the theme-token opacity rule',
    ],
    'drop the theme-token opacity rule',
  ],
  [
    'resolves the color-mix at build time',
    compilerStub({
      stylesheet: `{ s: [['x', [{ d: [[['calc', [['var', ['--spacing']], '*', 5]], 'lineHeight'], [{ color: '#b0483a10' }, 'backgroundColor']] }]]] }`,
    }),
    [
      'now compiles to {"color":"#b0483a10"} instead of a deferred colorMix — drop the theme-token opacity rule',
    ],
  ],
  [
    'emits no lineHeight declaration for the spacing-scale fixture',
    compilerStub({
      stylesheet: `{ s: [['x', [{ d: [[['colorMix', [['var', ['--color-destructive']]]], 'backgroundColor']] }]]] }`,
    }),
    [
      'a spacing-scale line height emits no lineHeight declaration — the ban still applies, so keep the numeric leading rule',
    ],
    'drop the numeric leading rule',
  ],
]) {
  test(`reports compiler pins when the stub ${name}, keeping the source findings`, context => {
    const root = stubbedCompilerFixture(context, entrySource);
    const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    // The source-tree findings made it out before the stub failed the pins.
    assert.match(result.stderr, /bans\.ts:1: "text-start" text-align: start is dropped/);
    for (const fragment of expected) {
      assert.match(result.stderr, new RegExp(fragment.replace(/[()]/g, m => `\\${m}`)));
    }
    if (absent !== undefined) {
      for (const fragment of [absent].flat()) {
        assert.doesNotMatch(result.stderr, new RegExp(fragment));
      }
    }
    assert.match(result.stderr, /check-classes: \d+ problem\(s\)/);
    assert.doesNotMatch(result.stderr, /Error:|at /);
  });
}

test('keeps the pins quiet when the control and the holding declarations compile', context => {
  const root = stubbedCompilerFixture(context, compilerStub(), {
    'apps/mobile/src/screen.tsx': screen('<ScrollView contentContainerClassName="px-4" />'),
  });
  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-classes: no dropped classes/);
  assert.doesNotMatch(result.stderr, /text-align/);
});

test('importing the module neither scans nor runs the compiler probes', context => {
  const root = importOnlyRoot(context);
  // A static import from a root with no source dirs, no global.css and no
  // installed dependencies: a scan would throw ENOENT, the compiler probe
  // cannot resolve react-native-css, and the audit would exit 1.
  writeFileSync(join(root, 'probe.mjs'), "import './tools/nativewind/check-classes.mjs';\n");
  const result = spawnSync(process.execPath, [join(root, 'probe.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('checkParsedFile reports one file and keeps no state between calls', context => {
  const root = makeFixture(context, {
    'apps/mobile/src/screen.tsx': screen('<ScrollView className="px-4" />'),
  });
  const source = '<ScrollView className="px-4" />';
  const absolute = join(root, 'apps/mobile/src/screen.tsx');
  const dir = join(root, 'apps/mobile/src');
  writeFileSync(
    join(root, 'probe.mjs'),
    [
      "import { checkParsedFile, layoutFindingText } from './tools/nativewind/check-classes.mjs';",
      "import { parseSourceEntry } from './tools/lib/source-files.mjs';",
      `const source = ${JSON.stringify(source)};`,
      `const absolute = ${JSON.stringify(absolute)};`,
      `const dir = ${JSON.stringify(dir)};`,
      `const root = ${JSON.stringify(root)};`,
      'const entry = parseSourceEntry(dir, root, absolute, source);',
      // The printable lines of one call, built the way the report builds them.
      'const lines = entry => {',
      '  const { problems, layout } = checkParsedFile(entry);',
      '  return [...problems, ...layout.map(layoutFindingText)];',
      '};',
      'const first = lines(entry);',
      'const firstAgain = lines(entry);',
      'const clean = lines(parseSourceEntry(dir, root, absolute, "export const a = 1;"));',
      'console.log(JSON.stringify({ first, firstAgain, clean }));',
    ].join('\n')
  );
  const result = spawnSync(process.execPath, [join(root, 'probe.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const { first, firstAgain, clean } = JSON.parse(result.stdout);
  assert.equal(first.length, 1);
  assert.match(first[0], /<ScrollView> carries "px-4" on its own className/);
  // A second call on the same entry sees this call's problems only, and a clean
  // file sees none.
  assert.deepEqual(firstAgain, first);
  assert.deepEqual(clean, []);
});

test('reads the container classes past a nested template literal', () => {
  const found = check(
    'apps/mobile/src/screen.tsx',
    'export const a = (\n' +
      '  <ScrollView\n' +
      '    renderItem={() => (\n' +
      "      <View accessibilityLabel={`${rows.map(row => `${row.name}'s`).join(', ')}`} />\n" +
      '    )}\n' +
      '    className="px-4"\n' +
      '  />\n' +
      ');\n'
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /screen\.tsx:2: <ScrollView> carries "px-4" on its own className/);
});

test('reads the container classes past an arrow type argument', () => {
  const found = check(
    'apps/mobile/src/screen.tsx',
    'export const a = <FlashList<() => void> data={rows} className="ps-3" />;\n'
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /screen\.tsx:1: <FlashList> carries "ps-3" on its own className/);
});

test('reads the container classes past a block comment holding a quote and a brace', () => {
  const found = check(
    'apps/mobile/src/screen.tsx',
    'export const a = (\n' +
      '  <ScrollView\n' +
      `    /* it's the "body" { } */\n` +
      '    className="pl-2"\n' +
      '  />\n' +
      ');\n'
  );
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /screen\.tsx:2: <ScrollView> carries "pl-2" on its own className/);
});

test('reports a source file the parser refuses', () => {
  const found = check('apps/mobile/src/broken.ts', 'const a = ;\n');
  // An unreadable file is a problem of its own: its tree is empty, so a silent
  // skip would report the file as clean.
  assert.ok(found.length > 0);
  assert.match(found.join('\n'), /broken\.ts:1: cannot parse: /);
});

test('reports each ban at its own line', () => {
  const found = check(
    'apps/mobile/src/bans.ts',
    'const a = 1;\n' +
      '\n' +
      'const b = "text-start text-end";\n' +
      'const c = 2;\n' +
      'const d = "leading-9";\n' +
      '/* "bg-primary/50" in the rule comment is documentation\n' +
      ' * text-start in a block-comment body */\n'
  );
  assert.deepEqual(found, [
    `apps/mobile/src/bans.ts:3: "text-start" text-align: start is dropped; the shared Text handles RTL alignment already`,
    `apps/mobile/src/bans.ts:3: "text-end" text-align: end is dropped; the shared Text handles RTL alignment already`,
    `apps/mobile/src/bans.ts:5: "leading-9" a numeric leading-N is multiplied by the font size at runtime; use an explicit length, e.g. leading-[1.25rem]`,
  ]);
});

test('reads a ban inside a template chunk but not one in a comment or a regular expression', () => {
  const found = check(
    'apps/mobile/src/bans.ts',
    'const a = `flex-1 text-start`;\n' +
      'const b = 1; // text-start is not a class here\n' +
      'const c = /text-start/;\n' +
      '/* ltr: and leading-9 in a comment body read as documentation */\n'
  );
  assert.deepEqual(found, [
    `apps/mobile/src/bans.ts:1: "text-start" text-align: start is dropped; the shared Text handles RTL alignment already`,
  ]);
});

test('flags a formatter whose call parenthesis starts the next line', () => {
  const found = check(
    'apps/mobile/src/format.ts',
    'export const a = Intl.NumberFormat\n' +
      '  ("en-US");\n' +
      'export const b = new Intl.DateTimeFormat\n' +
      '  ("en-US");\n'
  );
  const text = found.join('\n');
  assert.ok(found.length > 0);
  assert.match(text, /"new Intl\.DateTimeFormat" builds its own formatter/);
  // A call that wraps its parenthesis is the same formatter as one on a line.
  assert.match(text, /"Intl\.NumberFormat\(" builds its own formatter/);
});

test('reports a constructor whose new ends the previous line', () => {
  const found = check(
    'apps/mobile/src/format.ts',
    'export const a = new\nIntl.DateTimeFormat("en");\n'
  );
  // The constructor is reported where its name is, whichever line `new` took.
  assert.deepEqual(found, [
    `apps/mobile/src/format.ts:2: "new Intl.DateTimeFormat" builds its own formatter; go through @/lib/intl-cache so the locale is normalised once`,
  ]);
});

test('names every file from its root, inside the repository or a temporary tree', context => {
  const widget = 'apps/mobile/src/glanceable-ios/active-agents-widget.tsx';
  const source =
    "import { Text } from 'react-native';\n" + "export const a = Intl.DateTimeFormat('en-US');\n";
  // A file below the root is named from it, whatever spelling arrives up front.
  for (const relative of [
    'apps/mobile/src/panel.tsx',
    './apps/mobile/src/panel.tsx',
    '/apps/mobile/src/panel.tsx',
  ]) {
    const entry = parseSourceEntry(MOBILE_ROOT, REPO, join(REPO, relative), source);
    assert.equal(entry.path, 'apps/mobile/src/panel.tsx', 'POSIX separators, no leading separator');
    // Every diagnostic names that path, so the finding is the same file.
    assert.deepEqual(
      check(relative, source).map(problem => problem.split(':')[0]),
      ['apps/mobile/src/panel.tsx', 'apps/mobile/src/panel.tsx']
    );
  }
  // A file outside the root is named from the `dir` argument: the `..` segments go.
  const temp = mkdtempSync(join(tmpdir(), 'check-classes-path-'));
  context.after(() => rmSync(temp, { recursive: true, force: true }));
  const dir = join(temp, 'apps/mobile/src');
  const nested = join(dir, 'components');
  mkdirSync(nested, { recursive: true });
  const outside = join(nested, 'panel.tsx');
  writeFileSync(outside, source);
  const entry = parseSourceEntry(dir, REPO, outside, source);
  assert.equal(entry.path, 'components/panel.tsx');
  assert.equal(entry.file, outside);
  // The widget-process exemption reads the same normalised path as every check.
  const widgetSource = "export const a = Intl.DateTimeFormat('en-US');\n";
  assert.deepEqual(check(widget, widgetSource), [], 'the widget layout keeps its exemption');
});

// The layout contract's rules read a className value, a cn() argument and a
// *_CLASS constant, and stand down inside the modules that own the scale.

const ALLOWLISTED = 'apps/mobile/src/components/ui/panel.tsx';
const SCREEN_FILE = 'apps/mobile/src/screen.tsx';

function layoutProblems(relative, text) {
  return check(relative, text).filter(problem => /\[L\d+\]/.test(problem));
}

// The table is the only description of the layout rules, and the header says so.
// These three properties are what makes that claim hold instead of drift: a new
// rule cannot arrive with no detector, no two rules can share an id, and no rule
// can name two detectors and leave the dispatch to pick one.
test('states every layout rule once, with the detector that finds it', () => {
  const ids = LAYOUT_RULES.map(rule => rule.id);
  assert.deepEqual([...ids].sort(), [...new Set(ids)].sort(), 'two layout rules share an id');
  for (const rule of LAYOUT_RULES) {
    const detectors = ['patterns', 'detectSurface', 'detect'].filter(
      field => rule[field] !== undefined
    );
    assert.equal(
      detectors.length,
      1,
      `layout rule ${rule.id} must carry exactly one detector, has [${detectors.join(', ')}]`
    );
    assert.equal(
      typeof rule.advice,
      'string',
      `layout rule ${rule.id} must name the primitive that replaces it`
    );
    if (rule.patterns !== undefined) {
      assert.ok(rule.patterns.length > 0, `layout rule ${rule.id} has no pattern`);
    }
  }
});

test('flags arbitrary spacing outside the allowlist and passes it inside', () => {
  const found = layoutProblems(SCREEN_FILE, screen('<View className="mt-[6px]" />'));
  assert.equal(found.length, 1);
  assert.match(found[0], /screen\.tsx:3: \[L1\] "mt-\[6px\]"/);
  assert.match(found[0], /@\/lib\/layout/);
  assert.deepEqual(layoutProblems(ALLOWLISTED, screen('<View className="mt-[6px]" />')), []);
});

// A class that is the first thing on its source line is the closest a match can
// sit to the chunk's origin, so every source character the chunk spends before
// it — an escape, a line continuation — is a line the diagnostic can lose. Each
// source below writes `mt-[6px]` at the start of its fifth line: the template
// cooks six spaces and a newline ahead of it, and the quoted literal joins its
// line continuation onto the class's line.
test('names the line a layout class is written on, past the escape before it', () => {
  const sources = [
    [
      'a template chunk that opens six escapes before the newline',
      [
        'export function Screen() {',
        '  return (',
        '    <View',
        '      className={`\\u0020\\u0020\\u0020\\u0020\\u0020\\u0020',
        'mt-[6px]`} />',
        '  );',
        '}',
      ].join('\n'),
    ],
    [
      'a quoted literal whose line continuation joins the class onto the next line',
      [
        'export function Screen() {',
        '  return (',
        '    <View',
        '      className="px-4\\',
        'mt-[6px]" />',
        '  );',
        '}',
      ].join('\n'),
    ],
  ];
  for (const [name, source] of sources) {
    const found = layoutProblems(SCREEN_FILE, source);
    assert.equal(found.length, 1, name);
    const line = source.split('\n').findIndex(text => text.includes('mt-[6px]')) + 1;
    assert.equal(line, 5, `${name}: the fixture writes the class on line 5`);
    assert.match(found[0], new RegExp(`screen\\.tsx:${line}: \\[L1\\] "mt-\\[6px\\]"`), name);
  }
});

// Every escape the offset map walks is a branch of its own, and the tree has
// none of them today, so each is exercised only here. A quoted escape must sit
// in a `{…}` expression: a bare attribute string is not cooked, so it takes the
// identity path and would exercise nothing. Each fixture writes `mt-[6px]` as
// the first thing on its own source line, behind the escape named in its row,
// and the expected line is that class's own line.
test('maps every escape branch to the line the class is written on', () => {
  const cases = [
    [
      'an \\xXX and a \\uXXXX escape',
      [
        'export function Screen() {',
        '  return (',
        '    <View',
        '      className={"\\x41\\u0020\\',
        'mt-[6px]"} />',
        '  );',
        '}',
      ].join('\n'),
    ],
    [
      'an escape above the BMP',
      [
        'export function Screen() {',
        '  return (',
        '    <View',
        '      className={"\\u{1F600}\\u0020\\',
        'mt-[6px]"} />',
        '  );',
        '}',
      ].join('\n'),
    ],
    [
      'a template line continuation',
      [
        'export function Screen() {',
        '  return (',
        '    <View',
        '      className={`\\u0020\\',
        'mt-[6px]`} />',
        '  );',
        '}',
      ].join('\n'),
    ],
    [
      'a template chunk ending its line in CRLF',
      [
        'export function Screen() {',
        '  return (',
        '    <View',
        '      className={`\\u0020',
        'mt-[6px]`} />',
        '  );',
        '}',
      ].join('\r\n'),
    ],
    [
      'a template chunk holding a raw CRLF',
      [
        'export function Screen() {',
        '  return (',
        '    <View',
        '      className={`px-4',
        'mt-[6px]`} />',
        '  );',
        '}',
      ].join('\r\n'),
    ],
  ];
  for (const [name, source] of cases) {
    const found = layoutProblems(SCREEN_FILE, source);
    assert.equal(found.length, 1, name);
    const line = source.split(/\r\n|\n/).findIndex(text => text.startsWith('mt-')) + 1;
    assert.equal(line, 5, `${name}: the fixture writes the class on line 5`);
    assert.match(found[0], new RegExp(`screen\\.tsx:${line}: \\[L1\\] "mt-\\[6px\\]"`), name);
  }
});

test('flags an arbitrary text size but not an arbitrary text colour', () => {
  assert.match(
    layoutProblems(SCREEN_FILE, screen('<Text className="text-[13px]" />')).join('\n'),
    /\[L1\] "text-\[13px\]"/
  );
  assert.deepEqual(layoutProblems(SCREEN_FILE, screen('<Text className="text-[#ffffff]" />')), []);
});

test('flags a scroll body whose content container is not the px-4 gutter', () => {
  for (const classes of ['px-6', 'ps-3', 'p-3', 'px-[22px]']) {
    const found = layoutProblems(
      SCREEN_FILE,
      screen(`<DetailScreenScrollView contentContainerClassName="${classes}" />`)
    );
    assert.match(
      found.join('\n'),
      new RegExp(`\\[L2\\] ".+ on <DetailScreenScrollView> contentContainerClassName"`)
    );
    assert.match(found.join('\n'), /SCREEN_BODY_CLASS/);
  }
});

test('reads a variant-prefixed inset as the utility it applies', () => {
  for (const classes of ['md:px-6', 'landscape:px-6', 'ios:pl-2', 'md:pe-6', 'md:p-3']) {
    const found = layoutProblems(
      SCREEN_FILE,
      screen(`<DetailScreenScrollView contentContainerClassName="${classes}" />`)
    );
    const gutters = found.filter(problem => problem.includes('[L2]'));
    assert.equal(gutters.length, 1, classes);
    assert.match(gutters[0], new RegExp(`\\[L2\\] "${classes.replace(/[[\]]/g, '\\$&')} on`));
  }
  for (const classes of ['md:px-4', 'landscape:px-4']) {
    assert.deepEqual(
      layoutProblems(
        SCREEN_FILE,
        screen(`<DetailScreenScrollView contentContainerClassName="${classes}" />`)
      ),
      [],
      classes
    );
  }
  for (const classes of ['md:px-6', 'ios:pl-2', 'landscape:px-4']) {
    assert.match(
      layoutProblems(SCREEN_FILE, screen(`<ScreenHeader className="${classes}" />`)).join('\n'),
      new RegExp(`\\[L2\\] "${classes.replace(/[[\]]/g, '\\$&')} on <ScreenHeader> className"`)
    );
  }
});

test('accepts px-4 and vertical padding on a scroll body', () => {
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen('<FlashList contentContainerClassName="gap-6 px-4 pt-3" />')
    ),
    []
  );
});

test('flags a variant-prefixed page inset on a scroll body', () => {
  // The gutter rule reads a token's utility part, so a prefixed or important
  // inset is the same page inset the bare spelling writes, and the two RTL
  // rules stay pinned to one spelling.
  for (const classes of ['ios:px-6', '!ps-8']) {
    const found = layoutProblems(
      SCREEN_FILE,
      screen(`<DetailScreenScrollView contentContainerClassName="${classes}" />`)
    ).filter(problem => problem.includes('[L2]'));
    assert.equal(found.length, 1, classes);
    assert.match(
      found[0],
      new RegExp(`\\[L2\\] "${classes} on <DetailScreenScrollView> contentContainerClassName"`)
    );
  }
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen('<DetailScreenScrollView contentContainerClassName="px-4" />')
    ),
    []
  );
});

test('reads every scroll container in both RTL rules', () => {
  // The two rules read one inventory, so a container the gutter rule used to
  // miss is judged on its content container and one the className rule used to
  // miss is judged on its own className.
  assert.match(
    layoutProblems(SCREEN_FILE, screen('<FlatList contentContainerClassName="px-6" />')).join('\n'),
    /\[L2\] "px-6 on <FlatList> contentContainerClassName"/
  );
  assert.match(
    screenProblems(screen('<FlatList className="px-3" />')).join('\n'),
    /<FlatList> carries "px-3" on its own className/
  );
  for (const tag of ['DetailScreenScrollView', 'SheetScrollView']) {
    assert.match(
      layoutProblems(SCREEN_FILE, screen(`<${tag} contentContainerClassName="px-6" />`)).join('\n'),
      new RegExp(`\\[L2\\] "px-6 on <${tag}> contentContainerClassName"`),
      tag
    );
    assert.match(
      screenProblems(screen(`<${tag} className="px-3" />`)).join('\n'),
      new RegExp(`<${tag}> carries "px-3" on its own className`),
      tag
    );
  }
});

test('accepts the px-4 gutter on every scroll container and its Animated form', () => {
  for (const tag of [
    'ScrollView',
    'TabScreenScrollView',
    'DetailScreenScrollView',
    'SheetScrollView',
    'FlatList',
    'FlashList',
    'KeyboardAwareScrollView',
    'Animated.ScrollView',
    'Animated.FlatList',
  ]) {
    assert.deepEqual(
      layoutProblems(SCREEN_FILE, screen(`<${tag} contentContainerClassName="px-4" />`)),
      [],
      tag
    );
  }
});

test('flags a header className that writes the page gutter', () => {
  const found = layoutProblems(SCREEN_FILE, screen('<ScreenHeader className="px-[22px]" />'));
  assert.match(found.join('\n'), /\[L2\] "px-\[22px\] on <ScreenHeader> className"/);
  assert.deepEqual(
    layoutProblems(ALLOWLISTED, screen('<ScreenHeader className="px-[22px]" />')),
    []
  );
});

test('flags a section label written as a class outside the allowlist', () => {
  const found = layoutProblems(SCREEN_FILE, screen('<Text className="uppercase tracking-wide" />'));
  assert.equal(found.length, 2);
  assert.match(found.join('\n'), /\[L3\] "uppercase"/);
  assert.match(found.join('\n'), /\[L3\] "tracking-wide"/);
  assert.deepEqual(layoutProblems(ALLOWLISTED, screen('<Text className="uppercase" />')), []);
});

test('flags a card surface built by hand, including across one cn() call', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    screen("<View className={cn('bg-secondary', 'rounded-lg')} />")
  );
  assert.equal(found.length, 1);
  assert.match(found[0], /screen\.tsx:3: \[L4\] "bg-secondary rounded-lg"/);
  assert.deepEqual(
    layoutProblems(ALLOWLISTED, screen('<View className="bg-secondary rounded-lg" />')),
    []
  );
});

test('flags text-xl and larger outside the allowlist', () => {
  const found = layoutProblems(SCREEN_FILE, screen('<Text className="text-2xl" />'));
  assert.equal(found.length, 1);
  assert.match(found[0], /\[L5\] "text-2xl"/);
  assert.match(found[0], /ScreenHeader/);
  assert.deepEqual(layoutProblems(SCREEN_FILE, screen('<Text className="text-lg" />')), []);
  assert.deepEqual(layoutProblems(ALLOWLISTED, screen('<Text className="text-2xl" />')), []);
});

test('flags a numeric layout value in a style object, in a value and an array', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    screen(
      '<>',
      '<View style={{ paddingHorizontal: 16 }} />',
      '<View style={[{ marginTop: x + 8 }]} />',
      '</>'
    )
  );
  assert.equal(found.length, 2);
  assert.match(found.join('\n'), /screen\.tsx:4: \[L6\] "paddingHorizontal: 16"/);
  assert.match(found.join('\n'), /screen\.tsx:5: \[L6\] "marginTop: x \+ 8"/);
  assert.deepEqual(layoutProblems(ALLOWLISTED, screen('<View style={{ padding: 8 }} />')), []);
});

test('accepts layout read from an inset, the keyboard or a measurement', () => {
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen(
        '<View style={{ paddingTop: insets.top, gap: Math.max(0, measured), marginTop: 0 }} />'
      )
    ),
    []
  );
});

test('flags a chevron imported from the icon modules outside the allowlist', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    "import { ChevronRight } from '@/components/ui/icons';\n" +
      "import { DirectionalChevronRight } from '@/components/ui/directional-icons';\n" +
      'export const a = 1;\n'
  );
  assert.equal(found.length, 2);
  assert.match(found.join('\n'), /screen\.tsx:1: \[L7\] "ChevronRight"/);
  assert.match(found.join('\n'), /screen\.tsx:2: \[L7\] "DirectionalChevronRight"/);
  assert.match(found.join('\n'), /RowChevron/);
  assert.deepEqual(
    layoutProblems(ALLOWLISTED, "import { ChevronRight } from '@/components/ui/icons';\n"),
    []
  );
});

test('flags an arbitrary box size outside the allowlist and passes it inside', () => {
  const found = layoutProblems(SCREEN_FILE, screen('<View className="h-[46px]" />'));
  assert.equal(found.length, 1);
  assert.match(found[0], /screen\.tsx:3: \[L8\] "h-\[46px\]"/);
  assert.match(found[0], /tap-target/);
  assert.deepEqual(layoutProblems(ALLOWLISTED, screen('<View className="h-[46px]" />')), []);
});

test('flags an arbitrary minimum height outside the allowlist', () => {
  assert.match(
    layoutProblems(SCREEN_FILE, screen('<View className="min-h-[44px]" />')).join('\n'),
    /\[L8\] "min-h-\[44px\]"/
  );
});

test('passes percentage sizes and hairline arbitrary sizes', () => {
  assert.deepEqual(
    layoutProblems(SCREEN_FILE, screen('<View className="w-[50%] h-[0.5px] min-h-[1px]" />')),
    []
  );
});

test('flags an arbitrary size written as calc()', () => {
  assert.match(
    layoutProblems(SCREEN_FILE, screen('<View className="h-[calc(100%-4px)]" />')).join('\n'),
    /\[L8\] "h-\[calc\(100%-4px\)\]"/
  );
});

test('flags a card surface split across the branches of one className expression', () => {
  // A template literal: the fill in one chunk, the radius in a ternary branch.
  const templateUrl =
    "<View className={`mx-4 bg-secondary ${isFirst ? 'rounded-t-xl' : 'rounded-b-xl'}`} />";
  const template = layoutProblems(SCREEN_FILE, screen(templateUrl));
  assert.equal(template.length, 1);
  assert.match(template[0], /screen\.tsx:3: \[L4\] "bg-secondary rounded-t-xl"/);
  // A ternary between two cn() calls is still one element's class expression.
  const branches = layoutProblems(
    SCREEN_FILE,
    screen("<View className={isFirst ? cn('mx-4 bg-secondary') : cn('rounded-t-xl')} />")
  );
  assert.equal(branches.length, 1);
  assert.match(branches.join('\n'), /\[L4\] "bg-secondary rounded-t-xl"/);
  assert.deepEqual(
    layoutProblems(ALLOWLISTED, screen(templateUrl)),
    [],
    'the primitives own the pairing, so the allowlist still passes'
  );
});

test('accepts a card fill and a radius that are written on their own', () => {
  assert.deepEqual(layoutProblems(SCREEN_FILE, screen('<View className="bg-secondary" />')), []);
  assert.deepEqual(layoutProblems(SCREEN_FILE, screen('<View className="rounded-lg" />')), []);
});

test('flags a numeric layout value in a list style prop, not only style', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    screen(
      '<>',
      '<FlashList contentContainerStyle={{ paddingTop: 10.5 }} />',
      '<FlatList columnWrapperStyle={{ gap: 8 }} />',
      '<SectionList ListHeaderComponentStyle={[{ marginBottom: 12 }]} />',
      '</>'
    )
  );
  assert.equal(found.length, 3);
  assert.match(found.join('\n'), /screen\.tsx:4: \[L6\] "paddingTop: 10.5"/);
  assert.match(found.join('\n'), /screen\.tsx:5: \[L6\] "gap: 8"/);
  assert.match(found.join('\n'), /screen\.tsx:6: \[L6\] "marginBottom: 12"/);
});

test('flags a numeric layout value in every style prop of one element', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    screen(
      '<FlatList',
      '  style={{ marginTop: 4 }}',
      '  contentContainerStyle={{ paddingTop: 10.5 }}',
      '/>'
    )
  );
  assert.equal(found.length, 2);
  assert.match(found.join('\n'), /screen\.tsx:4: \[L6\] "marginTop: 4"/);
  assert.match(found.join('\n'), /screen\.tsx:5: \[L6\] "paddingTop: 10.5"/);
});

test('accepts measured values in a list style prop', () => {
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen(
        '<FlashList contentContainerStyle={{ paddingTop: insets.top }} />',
        '<FlatList columnWrapperStyle={{ gap: measured }} />'
      )
    ),
    []
  );
});

test('flags a row divider drawn in the border colour instead of the hairline', () => {
  const found = layoutProblems(SCREEN_FILE, screen('<View className="border-b border-border" />'));
  assert.equal(found.length, 1);
  assert.match(found[0], /screen\.tsx:3: \[L9\] "border-b border-border"/);
  assert.match(found[0], /border-hair-soft/);
  // A width on the side names the same divider.
  assert.match(
    layoutProblems(SCREEN_FILE, screen('<View className="border-t-2 border-border" />')).join('\n'),
    /\[L9\] "border-t-2 border-border"/
  );
  // The pair is one class expression, so a cn() call is the same divider.
  assert.match(
    layoutProblems(
      SCREEN_FILE,
      screen("<View className={cn('border-b', 'border-border')} />")
    ).join('\n'),
    /\[L9\] "border-b border-border"/
  );
  assert.deepEqual(
    layoutProblems(ALLOWLISTED, screen('<View className="border-b border-border" />')),
    []
  );
});

test('accepts a hairline divider and a full border', () => {
  assert.deepEqual(
    layoutProblems(SCREEN_FILE, screen('<View className="border-b border-hair-soft" />')),
    []
  );
  assert.deepEqual(
    layoutProblems(SCREEN_FILE, screen('<View className="border border-border" />')),
    []
  );
});

test('flags titleContent outside the screens that own a title line', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    screen('<ScreenHeader title="Sessions" titleContent={<Text />} />')
  );
  assert.equal(found.length, 1);
  assert.match(found[0], /screen\.tsx:3: \[L10\] "titleContent"/);
  assert.match(found[0], /titleAccessory/);
});

test('accepts titleContent in an allowlisted screen and titleAccessory anywhere', () => {
  const source = screen('<ScreenHeader title="Sessions" titleContent={<Text />} />');
  assert.deepEqual(layoutProblems('apps/mobile/src/components/home/home-screen.tsx', source), []);
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen('<ScreenHeader title="Sessions" titleAccessory={<Badge />} />')
    ),
    []
  );
});

test('flags a Sheet rendered without its SheetHeader', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    "import { Sheet } from '@/components/ui/sheet';\n" +
      screen('<Sheet visible onClose={onClose}>', '<Text>body</Text>', '</Sheet>')
  );
  assert.equal(found.length, 1);
  assert.match(found.join('\n'), /screen\.tsx:4: \[L11\] "<Sheet>"/);
  assert.match(found.join('\n'), /SheetHeader/);
  // An aliased import is the same component.
  assert.match(
    layoutProblems(
      SCREEN_FILE,
      "import { Sheet as SheetSurface } from '@/components/ui/sheet';\n" +
        screen('<SheetSurface visible onClose={onClose} />')
    ).join('\n'),
    /\[L11\] "<SheetSurface>"/
  );
});

test('accepts a Sheet with its header, an allowlisted sheet and a local Sheet', () => {
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      "import { Sheet } from '@/components/ui/sheet';\n" +
        screen(
          '<Sheet visible onClose={onClose}>',
          '<SheetHeader title="Environment" onDone={onClose} />',
          '</Sheet>'
        )
    ),
    []
  );
  // A confirmation dialog owns its first row instead of a title row.
  assert.deepEqual(
    layoutProblems(
      'apps/mobile/src/components/destructive-confirm-dialog.tsx',
      "import { Sheet } from '@/components/ui/sheet';\n" +
        screen('<Sheet visible onClose={onClose}>', '<Text>body</Text>', '</Sheet>')
    ),
    []
  );
  // A local component named Sheet is not the ui primitive.
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      "import { Sheet } from './local-sheet';\n" + screen('<Sheet visible onClose={onClose} />')
    ),
    []
  );
});

test('flags each sheet that lacks its own header', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    "import { Sheet } from '@/components/ui/sheet';\n" +
      screen(
        '<>',
        '<Sheet visible onClose={onClose}>',
        '<SheetHeader title="Environment" onDone={onClose} />',
        '</Sheet>',
        '<Sheet visible={other} onClose={onClose}>',
        '<Text>body</Text>',
        '</Sheet>',
        '</>'
      )
  );
  assert.equal(found.length, 1);
  assert.match(found.join('\n'), /screen\.tsx:8: \[L11\] "<Sheet>"/);
  // A header inside the sibling sheet says nothing about this one.
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      "import { Sheet } from '@/components/ui/sheet';\n" +
        screen(
          '<>',
          '<Sheet visible onClose={onClose}>',
          '<SheetHeader title="Environment" onDone={onClose} />',
          '</Sheet>',
          '<Sheet visible={other} onClose={onClose}>',
          '<SheetHeader title="Advanced" onDone={onClose} />',
          '</Sheet>',
          '</>'
        )
    ),
    []
  );
  // A nested sheet's header does not serve the sheet around it.
  assert.match(
    layoutProblems(
      SCREEN_FILE,
      "import { Sheet } from '@/components/ui/sheet';\n" +
        screen(
          '<>',
          '<Sheet visible onClose={onClose}>',
          '<Sheet visible={other} onClose={onClose}>',
          '<SheetHeader title="Advanced" onDone={onClose} />',
          '</Sheet>',
          '</Sheet>',
          '</>'
        )
    ).join('\n'),
    /screen\.tsx:5: \[L11\] "<Sheet>"/
  );
});

test('follows a local component that draws the sheet header', () => {
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      "import { Sheet } from '@/components/ui/sheet';\n" +
        'function FilterContent() {\n' +
        '  return <SheetHeader title="Filters" onDone={onClose} />;\n' +
        '}\n' +
        'export function Screen() {\n' +
        '  return (\n' +
        '    <Sheet visible onClose={onClose}>\n' +
        '      <FilterContent />\n' +
        '    </Sheet>\n' +
        '  );\n' +
        '}'
    ),
    []
  );
});

test('does not accept a nested sheet header drawn through a local component', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    "import { Sheet } from '@/components/ui/sheet';\n" +
      'function AdvancedContent() {\n' +
      '  return <SheetHeader title="Advanced" onDone={onClose} />;\n' +
      '}\n' +
      'export function Screen() {\n' +
      '  return (\n' +
      '    <Sheet visible onClose={onClose}>\n' +
      '      <Sheet visible={other} onClose={onClose}>\n' +
      '        <AdvancedContent />\n' +
      '      </Sheet>\n' +
      '    </Sheet>\n' +
      '  );\n' +
      '}'
  );
  assert.equal(found.length, 1);
  assert.match(found[0], /screen\.tsx:7: \[L11\] "<Sheet>"/);
});

test('flags horizontal padding on a CenteredState content container', () => {
  for (const classes of ['px-6', 'ps-3', 'pe-1', 'pl-2', 'pr-2', 'p-3']) {
    const found = layoutProblems(
      SCREEN_FILE,
      screen(`<CenteredState contentContainerClassName="${classes}" />`)
    ).filter(problem => problem.includes('[L2]'));
    assert.equal(found.length, 1, classes);
    assert.match(found[0], /\[L2\] ".+ on <CenteredState> contentContainerClassName"/);
    assert.match(found[0], /SCREEN_BODY_CLASS/);
  }
});

test('flags a horizontal inset wider than the page gutter', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    screen('<View className="px-6 mx-6 ps-10 pe-8 me-5" />')
  );
  assert.equal(found.length, 5);
  for (const token of ['px-6', 'mx-6', 'ps-10', 'pe-8', 'me-5']) {
    assert.match(found.join('\n'), new RegExp(`\\[L12\\] "${token}"`));
  }
  assert.match(found[0], /SCREEN_GUTTER_CLASS/);
  // A responsive or negative form is the same inset.
  const variants = layoutProblems(SCREEN_FILE, screen('<View className="md:px-8 -mx-6" />'));
  assert.equal(variants.length, 2);
  assert.match(variants.join('\n'), /\[L12\] "px-8"/);
  assert.match(variants.join('\n'), /\[L12\] "-mx-6"/);
  // The important modifier is written on either side of the utility and only
  // raises its specificity, so both report the same inset; the diagnostic names
  // the utility without the modifier.
  const important = layoutProblems(SCREEN_FILE, screen('<View className="!px-6 px-6!" />'));
  assert.equal(important.length, 2);
  for (const problem of important) {
    assert.match(problem, /\[L12\] "px-6"/);
  }
  // Every shape of a wider inset is one decision against the gutter: an
  // all-side form and a half step are judged beside the side forms, and the
  // diagnostic keeps the utility the call site wrote.
  const shapes = layoutProblems(
    SCREEN_FILE,
    screen('<View className="p-6 m-10 px-4.5 px-12.5" />')
  );
  assert.equal(shapes.length, 4);
  for (const token of ['p-6', 'm-10', 'px-4.5', 'px-12.5']) {
    assert.match(shapes.join('\n'), new RegExp(`\\[L12\\] "${token.replace('.', '\\.')}"`));
  }
});

test('gives one wider inset one decision from both inset rules', () => {
  // The two rules read the same table: on a surface that owns the page column
  // a wider inset is both the wrong gutter and wider than it, and on a plain
  // element only the width rule applies.
  const container = layoutProblems(
    SCREEN_FILE,
    screen('<ScrollView contentContainerClassName="p-6" />')
  );
  assert.equal(container.length, 2);
  assert.match(container.join('\n'), /\[L2\] "p-6 on <ScrollView> contentContainerClassName"/);
  assert.match(container.join('\n'), /\[L12\] "p-6"/);
  const view = layoutProblems(SCREEN_FILE, screen('<View className="p-6" />'));
  assert.equal(view.length, 1);
  assert.match(view[0], /\[L12\] "p-6"/);
  assert.doesNotMatch(view[0], /\[L2\]/);
});

test('leaves an arbitrary inset to the rule that bans it', () => {
  // The width rule reads a number of steps; an arbitrary value is not one, so
  // it stays L1's single finding instead of being reported twice.
  const found = layoutProblems(SCREEN_FILE, screen('<View className="px-[22px]" />'));
  assert.equal(found.length, 1);
  assert.match(found[0], /\[L1\] "px-\[22px\]"/);
  assert.doesNotMatch(found[0], /\[L12\]/);
});

test('accepts the gutter, a narrower inset and the modules that own one', () => {
  assert.deepEqual(
    layoutProblems(SCREEN_FILE, screen('<View className="px-4 gap-x-6 px-3 ps-2 mt-6" />')),
    []
  );
  assert.deepEqual(layoutProblems(ALLOWLISTED, screen('<View className="px-6 mx-8" />')), []);
});

test('accepts the gutter in both all-side forms beside an exempt margin and a narrower step', () => {
  // The gutter as a padding both ways, the same gutter under the important
  // modifier on either side, a zero and an auto margin the rule exempts, a half
  // step below the gutter, and the vertical utilities the family never held.
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen('<View className="p-4 px-4 !px-4 px-4! m-0 mx-auto px-3.5 gap-6 py-6 mt-6 pb-5" />')
    ),
    []
  );
});

test('flags a margin on a scroll content container as the page inset', () => {
  // The page inset is one family: a margin moves the content container's
  // column exactly as a padding does, so the gutter rule judges both.
  for (const classes of ['mx-6', 'ms-4', 'ml-3', 'm-2', 'me-1']) {
    const found = layoutProblems(
      SCREEN_FILE,
      screen(`<DetailScreenScrollView contentContainerClassName="${classes}" />`)
    ).filter(problem => problem.includes('[L2]'));
    assert.equal(found.length, 1, classes);
    assert.match(
      found[0],
      new RegExp(`\\[L2\\] "${classes} on <DetailScreenScrollView> contentContainerClassName"`)
    );
  }
  assert.match(
    layoutProblems(SCREEN_FILE, screen('<CenteredState contentContainerClassName="mx-6" />')).join(
      '\n'
    ),
    /\[L2\] "mx-6 on <CenteredState> contentContainerClassName"/
  );
  // A margin on an element that is not one of those surfaces is L12's business
  // when it is wider than the gutter and nobody's below it, so a plain View
  // never reads as L2.
  assert.doesNotMatch(
    layoutProblems(SCREEN_FILE, screen('<View className="mx-6 ml-3 m-2" />')).join('\n'),
    /\[L2\]/
  );
});

test('exempts auto and zero margins from the page-inset rule', () => {
  // An auto margin is centering geometry and a zero margin writes no inset at
  // all, so neither moves the page column L2 judges; neither is a number of
  // steps on the scale, so L12 skips both as well and no rule judges them.
  for (const classes of ['mx-auto', 'ms-auto', 'm-auto', 'mx-0', 'm-0']) {
    for (const tag of ['DetailScreenScrollView', 'CenteredState']) {
      const found = layoutProblems(
        SCREEN_FILE,
        screen(`<${tag} contentContainerClassName="${classes}" />`)
      ).filter(problem => problem.includes('[L2]'));
      assert.deepEqual(found, [], `${classes} on <${tag}>`);
    }
  }
  // A padding is not exempt, and a margin that moves the column still is the
  // page inset: `px-0` on a content container is exactly the gutterless column
  // this rule exists for.
  for (const classes of ['mx-6', 'm-6', 'px-0', 'p-2']) {
    const found = layoutProblems(
      SCREEN_FILE,
      screen(`<DetailScreenScrollView contentContainerClassName="${classes}" />`)
    ).filter(problem => problem.includes('[L2]'));
    assert.equal(found.length, 1, classes);
    assert.match(
      found[0],
      new RegExp(`\\[L2\\] "${classes} on <DetailScreenScrollView> contentContainerClassName"`)
    );
  }
});

test('keeps the header gutter rule padding-only', () => {
  // A header owns its own gutter, so a screen must not write padding on it.
  // A margin is not that: it moves the header's own box, and the all-side
  // padding policy says nothing about it. `mx-2` is under L12's threshold too,
  // so it is accepted outright.
  assert.deepEqual(layoutProblems(SCREEN_FILE, screen('<ScreenHeader className="mx-2" />')), []);
  assert.deepEqual(layoutProblems(SCREEN_FILE, screen('<ScreenHeader className="ml-3" />')), []);
  // A margin wider than the gutter is neither an L2 line (padding only) nor
  // unflagged: L12 owns the page inset.
  const margin = layoutProblems(SCREEN_FILE, screen('<ScreenHeader className="mx-6" />'));
  assert.equal(margin.length, 1);
  assert.match(margin[0], /\[L12\] "mx-6"/);
  // A padding wider than the gutter is both: L2 because a header takes no
  // padding of its own, L12 because the inset is wider than the gutter.
  const padding = layoutProblems(SCREEN_FILE, screen('<ScreenHeader className="px-5" />'));
  assert.equal(padding.length, 2);
  assert.match(padding.join('\n'), /\[L12\] "px-5"/);
  assert.match(padding.join('\n'), /\[L2\] "px-5 on <ScreenHeader> className"/);
});

test('leaves vertical inset out of the page-inset family', () => {
  // The family is horizontal only: a page inset is the column a screen's
  // content sits in, so a vertical margin or padding moves an element's own
  // box and neither rule reports it.
  for (const classes of ['mt-6', 'mb-8', 'py-6', 'my-4']) {
    assert.deepEqual(
      layoutProblems(
        SCREEN_FILE,
        screen(`<DetailScreenScrollView contentContainerClassName="${classes}" />`)
      ),
      [],
      classes
    );
    assert.deepEqual(
      layoutProblems(SCREEN_FILE, screen(`<ScreenHeader className="${classes}" />`)),
      [],
      classes
    );
    assert.deepEqual(
      layoutProblems(SCREEN_FILE, screen(`<View className="${classes}" />`)),
      [],
      classes
    );
  }
});

test('accepts the page gutter and vertical padding on a CenteredState', () => {
  assert.deepEqual(
    layoutProblems(SCREEN_FILE, screen('<CenteredState contentContainerClassName="px-4 py-6" />')),
    []
  );
  // The gutter check (L2) is scoped to the centered band; a plain view is held
  // to the page inset by the class rule instead.
  const view = layoutProblems(SCREEN_FILE, screen('<View className="px-6" />'));
  assert.equal(view.length, 1);
  assert.match(view[0], /\[L12\] "px-6"/);
});

test('judges every side the inset table lists, all-side forms included', () => {
  const found = layoutProblems(SCREEN_FILE, screen('<View className="ml-6 mr-8" />'));
  assert.equal(found.length, 2);
  assert.match(found.join('\n'), /\[L12\] "ml-6"/);
  assert.match(found.join('\n'), /\[L12\] "mr-8"/);
  // The all-side utilities are the same family now: `p-5` and `m-6` are wider
  // than the one gutter, so one rule judges them beside the side forms.
  const all = layoutProblems(SCREEN_FILE, screen('<View className="p-5 m-6" />'));
  assert.equal(all.length, 2);
  assert.match(all.join('\n'), /\[L12\] "p-5"/);
  assert.match(all.join('\n'), /\[L12\] "m-6"/);
  // The gutter itself, a zero margin and an auto margin are not wider than it.
  assert.deepEqual(layoutProblems(SCREEN_FILE, screen('<View className="p-4 m-0 mx-auto" />')), []);
  // A vertical utility is not a page inset, whatever its step.
  assert.deepEqual(layoutProblems(SCREEN_FILE, screen('<View className="pb-5 my-6" />')), []);
});

test('reads an Animated container through the one bare-tag helper in both rules', () => {
  // One lookup strips the wrapper, so both RTL rules judge `Animated.X` as the
  // container it renders. The line still prints the source spelling.
  const gutter = layoutProblems(
    SCREEN_FILE,
    screen('<Animated.FlatList contentContainerClassName="mx-6" />')
  );
  assert.match(
    gutter.join('\n'),
    /\[L2\] "mx-6 on <Animated\.FlatList> contentContainerClassName"/
  );
  assert.match(
    screenProblems(screen('<Animated.ScrollView className="px-3" />')).join('\n'),
    /<Animated\.ScrollView> carries "px-3" on its own className/
  );
});

test('flags a plain Button passed as a state action', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    screen(
      '<EmptyState icon={Inbox} title="Nothing" action={<Button onPress={add}><Text>Add</Text></Button>} />'
    )
  );
  assert.equal(found.length, 1);
  assert.match(found[0], /\[L13\] "<Button>"/);
  assert.match(found[0], /StateAction/);

  const nested = layoutProblems(
    SCREEN_FILE,
    screen(
      '<QueryError message="Failed" action={<View><Button onPress={retry}><Text>Retry</Text></Button></View>} />'
    )
  );
  assert.equal(nested.length, 1);
  assert.match(nested[0], /\[L13\]/);
});

test('accepts StateAction and wrappers around it in a state action', () => {
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen(
        '<EmptyState icon={Inbox} title="Nothing" action={<StateAction label="Add" icon={Plus} onPress={add} />} />'
      )
    ),
    []
  );
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen(
        '<QueryError action={<View className="gap-3"><StateAction label="Retry" icon={RotateCcw} onPress={retry} /></View>} />'
      )
    ),
    []
  );
});

/**
 * Run the checker's entry point over a fixture root whose sources carry one
 * layout violation, with `baseline` written beside it.
 */
function runLayoutFixture(context, sources, baseline) {
  const files = { ...sources };
  if (baseline !== undefined) {
    files['tools/nativewind/layout-baseline.json'] = `${JSON.stringify(baseline, null, 2)}\n`;
  }
  return runFixtureRoot(context, files);
}

/**
 * Run the entry point over a fixture whose baseline is written as raw text:
 * the helper above always `JSON.stringify`s the baseline it is given, so it
 * cannot produce a file whose text is not valid JSON, and rewriting that file's
 * bytes is the only way to state one. Some shapes the shape check must reject
 * would round-trip through the helper unchanged (`{"L1": "3"}` does, `[]` does),
 * but unparseable text — a trailing comma — cannot, so this helper writes the
 * file's own bytes for both kinds of defect.
 */
function runRawBaselineFixture(context, sources, baselineText) {
  return runFixtureRoot(context, {
    ...sources,
    'tools/nativewind/layout-baseline.json': baselineText,
  });
}

function runFixtureRoot(context, files) {
  const root = makeFixture(context, files);
  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

test('passes a layout violation the baseline admits exactly', context => {
  const result = runLayoutFixture(
    context,
    { 'apps/mobile/src/screen.tsx': screen('<View className="mt-[6px]" />') },
    { 'apps/mobile/src/screen.tsx': { L1: 1 } }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /1 layout violation\(s\) admitted/);
});

test('fails a file that exceeds its baseline for a rule', context => {
  const result = runLayoutFixture(
    context,
    {
      'apps/mobile/src/screen.tsx': screen(
        '<>',
        '<View className="mt-[6px]" />',
        '<View className="gap-[9px]" />',
        '</>'
      ),
    },
    { 'apps/mobile/src/screen.tsx': { L1: 1 } }
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\[L1\] "gap-\[9px\]"/);
  assert.match(result.stderr, /screen\.tsx: L1 now has 2 violation\(s\) and the baseline admits 1/);
});

test('fails a baseline entry the file is now below', context => {
  const result = runLayoutFixture(
    context,
    { 'apps/mobile/src/screen.tsx': screen('<View className="mt-[6px]" />') },
    { 'apps/mobile/src/screen.tsx': { L1: 2 } }
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /layout-baseline\.json: apps\/mobile\/src\/screen\.tsx L1 baseline is 2 but the file now has 1; lower it to 1/
  );
});

test('reports a malformed baseline as an instrument problem and skips the comparison', context => {
  // A shape the comparison cannot read is reported where the theme failure is,
  // and the comparison is skipped: a string count or an array would otherwise
  // be compared silently and pass or fail for the wrong reason.
  for (const [name, baselineText, detail] of [
    [
      'a string count',
      '{"apps/mobile/src/screen.tsx": {"L1": "3"}}',
      'apps/mobile/src/screen.tsx L1 is not a non-negative integer',
    ],
    [
      'a float count',
      '{"apps/mobile/src/screen.tsx": {"L1": 1.5}}',
      'apps/mobile/src/screen.tsx L1 is not a non-negative integer',
    ],
    [
      'a negative count',
      '{"apps/mobile/src/screen.tsx": {"L1": -1}}',
      'apps/mobile/src/screen.tsx L1 is not a non-negative integer',
    ],
    [
      'a null rule map',
      '{"apps/mobile/src/screen.tsx": null}',
      'apps/mobile/src/screen.tsx is not one rule map per file path',
    ],
    ['a top-level array', '[]', 'the file does not hold one rule map per file path'],
  ]) {
    const result = runRawBaselineFixture(
      context,
      { 'apps/mobile/src/screen.tsx': screen('<View className="mt-[6px]" />') },
      baselineText
    );
    assert.equal(result.status, 1, name);
    assert.match(
      result.stderr,
      new RegExp(
        `check-classes: cannot read the layout baseline from tools/nativewind/layout-baseline\\.json \\(${detail.replace(/[.()]/g, m => `\\${m}`)}\\) — the layout baseline comparison cannot run without it and was skipped`
      ),
      name
    );
    // No comparison line: the finding is admitted by nothing and reported as
    // neither exceeded nor stale.
    assert.doesNotMatch(result.stderr, /exceeded|lower it to|now has \d+ violation/, name);
    assert.match(result.stderr, /check-classes: 1 problem\(s\)/, name);
    assert.doesNotMatch(result.stderr, /Error:|at /, name);
  }
});

test('reports an unparseable baseline as an instrument problem and keeps the stale comparison', context => {
  // Unparseable text is the one defect the shape check never sees: JSON.parse
  // throws before it reaches. It is reported where the shape failure is, and
  // the comparison is skipped rather than run against the empty shape.
  const unparseable = runRawBaselineFixture(
    context,
    { 'apps/mobile/src/screen.tsx': screen('<View className="mt-[6px]" />') },
    '{"apps/mobile/src/screen.tsx": {"L1": 1,}}'
  );
  assert.equal(unparseable.status, 1, unparseable.stdout);
  assert.match(
    unparseable.stderr,
    /cannot read the layout baseline from tools\/nativewind\/layout-baseline\.json \(Expected .* in JSON/
  );
  assert.match(
    unparseable.stderr,
    /the layout baseline comparison cannot run without it and was skipped/
  );
  assert.doesNotMatch(unparseable.stderr, /exceeded|lower it to|now has \d+ violation/);
  assert.match(unparseable.stderr, /check-classes: 1 problem\(s\)/);
  // No stack trace: the failure is reported, not thrown. The parse detail ends
  // in "at position N", so only a stack frame's leading indentation is a tell.
  assert.doesNotMatch(unparseable.stderr, /Error:/);
  assert.doesNotMatch(unparseable.stderr, /^\s+at /m);

  // A baseline that parses still compares: the same file with a stale entry
  // keeps its own line and never mentions the instrument.
  const stale = runLayoutFixture(
    context,
    { 'apps/mobile/src/screen.tsx': screen('<View className="mt-[6px]" />') },
    { 'apps/mobile/src/screen.tsx': { L1: 2 } }
  );
  assert.equal(stale.status, 1, stale.stdout);
  assert.match(
    stale.stderr,
    /layout-baseline\.json: apps\/mobile\/src\/screen\.tsx L1 baseline is 2 but the file now has 1; lower it to 1/
  );
  assert.doesNotMatch(stale.stderr, /cannot read the layout baseline/);
});

test('writes the baseline with --write-layout-baseline', context => {
  const root = makeFixture(context, {
    'apps/mobile/src/screen.tsx': screen(
      '<View className="mt-[6px] uppercase bg-secondary rounded-lg" />'
    ),
  });
  const result = spawnSync(
    process.execPath,
    [join(root, 'tools/nativewind/check-classes.mjs'), '--write-layout-baseline'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'tools/nativewind/layout-baseline.json'), 'utf8')),
    {
      'apps/mobile/src/screen.tsx': { L1: 1, L3: 1, L4: 1 },
    }
  );
});

// A stylesheet the theme read cannot use: the block a moved or renamed
// global.css would lose. The audit must report why the one theme-dependent
// rule was skipped instead of ending on that read, and every other rule's
// findings must still print.
const THEME_SOURCE = 'export const a = <View className="leading-9 bg-primary/50" />;\n';

test('skips only the theme rule and keeps the other findings when global.css has no @theme block', context => {
  const root = makeFixture(
    context,
    { 'apps/mobile/src/screen.tsx': THEME_SOURCE },
    ':root { --x: 1; }\n'
  );
  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /check-classes: cannot read the @theme inline tokens from apps\/mobile\/src\/global\.css \(no @theme inline block\)/
  );
  // The ban the other rules still make reaches the report.
  assert.match(result.stderr, /leading-9/);
  // The skipped rule's own diagnostic must not claim the token was checked.
  assert.doesNotMatch(result.stderr, /bg-primary\/50/);
  assert.match(result.stderr, /check-classes: \d+ problem\(s\)/);
  assert.doesNotMatch(result.stderr, /Error:/);
  // A stack trace means the theme read escaped the problem list.
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('names the missing global.css and keeps the other findings', context => {
  const root = makeFixture(context, { 'apps/mobile/src/screen.tsx': THEME_SOURCE }, null);
  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /check-classes: cannot read the @theme inline tokens from apps\/mobile\/src\/global\.css \(ENOENT/
  );
  assert.match(result.stderr, /leading-9/);
  assert.doesNotMatch(result.stderr, /bg-primary\/50/);
  assert.match(result.stderr, /check-classes: \d+ problem\(s\)/);
  assert.doesNotMatch(result.stderr, /Error:/);
});

test('--write-layout-baseline reports a theme failure instead of rewriting the baseline', context => {
  const root = makeFixture(
    context,
    { 'apps/mobile/src/screen.tsx': THEME_SOURCE },
    ':root { --x: 1; }\n'
  );
  const result = spawnSync(
    process.execPath,
    [join(root, 'tools/nativewind/check-classes.mjs'), '--write-layout-baseline'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /check-classes: cannot read the @theme inline tokens from apps\/mobile\/src\/global\.css \(no @theme inline block\)/
  );
  assert.match(result.stderr, /check-classes: 1 problem\(s\)/);
  assert.doesNotMatch(result.stdout, /wrote/);
  // A baseline written here would record a tree the audit never checked.
  assert.throws(
    () => readFileSync(join(root, 'tools/nativewind/layout-baseline.json'), 'utf8'),
    /ENOENT/
  );
});

test('reports an @theme inline block holding no colour token as the theme failure', context => {
  const root = makeFixture(
    context,
    { 'apps/mobile/src/screen.tsx': THEME_SOURCE },
    ':root {}\n@theme inline {\n  --font-sans: var(--font-x);\n}\n'
  );
  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no --color token in the @theme inline block/);
  assert.match(result.stderr, /leading-9/);
  // The rule has no token to build its pattern from, so it must not run.
  assert.doesNotMatch(result.stderr, /bg-primary\/50/);
  assert.match(result.stderr, /check-classes: \d+ problem\(s\)/);
});

test('--write-layout-baseline refuses when a walked file cannot be read', async context => {
  const root = makeFixture(context, {
    'apps/mobile/src/screen.tsx': screen('<View className="mt-[6px]" />'),
  });
  const unreadable = join(root, 'apps/mobile/src/screen.tsx');
  // The fixture's own copy of the checker, so the run it exposes walks the
  // fixture and would write there: one file's read fails, every other read is
  // the filesystem's.
  const { run } = await import(
    pathToFileURL(join(root, 'tools/nativewind/check-classes.mjs')).href
  );
  const errors = [];
  const originalError = console.error;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  console.error = message => {
    errors.push(String(message));
  };
  // The injected writer is what a refused run must not reach: touching the
  // baseline file itself would prove nothing about which writer ran.
  let written = 0;
  let exitCode;
  try {
    run({
      read: (file, ...rest) => {
        if (file === unreadable) {
          throw new Error('EACCES: permission denied');
        }
        return readFileSync(file, ...rest);
      },
      writeBaseline: () => {
        written += 1;
      },
    });
    exitCode = process.exitCode;
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
  assert.equal(exitCode, 1, errors.join('\n'));
  assert.equal(written, 0);
  const report = errors.join('\n');
  assert.match(report, /apps\/mobile\/src\/screen\.tsx: cannot read: EACCES: permission denied/);
  assert.match(report, /check-classes: 1 problem\(s\)/);
  // A baseline written here would record a tree the audit never checked.
  assert.throws(
    () => readFileSync(join(root, 'tools/nativewind/layout-baseline.json'), 'utf8'),
    /ENOENT/
  );
});

test('--write-layout-baseline refuses when a fixture source does not parse', context => {
  const root = makeFixture(context, {
    'apps/mobile/src/broken.tsx': 'export const a = <View className=; />;\n',
  });
  const result = spawnSync(
    process.execPath,
    [join(root, 'tools/nativewind/check-classes.mjs'), '--write-layout-baseline'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /broken\.tsx:\d+: cannot parse: /);
  assert.match(result.stderr, /check-classes: [1-9]\d* problem\(s\)/);
  assert.doesNotMatch(result.stdout, /wrote/);
  // The refused file may hold any number of violations, so no count is safe.
  assert.throws(
    () => readFileSync(join(root, 'tools/nativewind/layout-baseline.json'), 'utf8'),
    /ENOENT/
  );
});

test('a second run reads the theme through its own seam instead of the first run memo', async context => {
  // The memo exists so one run reads the theme once. A module-level cache that
  // survived the first run would report the first run's tokens (or its lack of
  // a failure) on the second, which is exactly the leak this pins.
  const root = makeFixture(context, {
    'apps/mobile/src/screen.tsx': screen('<View />'),
  });
  const { run } = await import(
    pathToFileURL(join(root, 'tools/nativewind/check-classes.mjs')).href
  );
  const errors = [];
  const originalError = console.error;
  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  console.error = message => {
    errors.push(String(message));
  };
  console.log = () => {};
  const readers = [
    () => ({ tokens: ['primary'], failure: null }),
    () => ({ tokens: null, failure: 'boom' }),
  ];
  let firstExitCode;
  let secondExitCode;
  try {
    run({ readTheme: () => readers[0](), readBaseline: () => ({ baseline: {}, failure: null }) });
    firstExitCode = process.exitCode;
    process.exitCode = undefined;
    run({ readTheme: () => readers[1](), readBaseline: () => ({ baseline: {}, failure: null }) });
    secondExitCode = process.exitCode;
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }
  // The first run read a theme with no failure and an admitted empty baseline.
  assert.notEqual(firstExitCode, 1);
  // The second run reports its own failure: the memo did not carry the first
  // run's successful read into it.
  assert.equal(secondExitCode, 1);
  assert.match(errors.join('\n'), /boom/);
});

test('restores the theme memo after a run so a later direct check reads the real tokens', async context => {
  // A run seeds the module-level memos from its own reader. Left there, an
  // injected theme would decide what a direct check after the run reports, so
  // the run restores the caches the module held before it.
  const root = makeFixture(context, {
    'apps/mobile/src/screen.tsx': screen('<View />'),
  });
  const { run, checkParsedFile } = await import(
    pathToFileURL(join(root, 'tools/nativewind/check-classes.mjs')).href
  );
  const { parseSourceEntry } = await import(
    pathToFileURL(join(root, 'tools/lib/source-files.mjs')).href
  );
  const appSrc = join(root, 'apps/mobile/src');
  const probe = () =>
    checkParsedFile(
      parseSourceEntry(
        appSrc,
        root,
        join(appSrc, 'panel.tsx'),
        'export const a = <View className="bg-primary/50" />;\n'
      )
    ).problems;
  // The control: the theme rule reports before any run, so an empty result
  // after one says the memo leaked and not that the rule never fires here.
  const before = probe();
  assert.match(before.join('\n'), /\/opacity modifier is dropped/);
  const errors = [];
  const originalError = console.error;
  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  console.error = message => {
    errors.push(String(message));
  };
  console.log = () => {};
  let exitCode;
  try {
    run({
      readTheme: () => ({ tokens: null, failure: 'boom' }),
      readBaseline: () => ({ baseline: {}, failure: null }),
    });
    exitCode = process.exitCode;
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }
  // The seam was used: the run reports the injected failure and fails.
  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /boom/);
  // The direct check reads global.css again, exactly as it did before the run.
  assert.deepEqual(probe(), before);
});

test('run writes and reads the baseline through its injected seams', async context => {
  const root = makeFixture(context, {
    'apps/mobile/src/screen.tsx': screen('<View className="mt-[6px]" />'),
  });
  const { run } = await import(
    pathToFileURL(join(root, 'tools/nativewind/check-classes.mjs')).href
  );
  const written = [];
  let reads = 0;
  // The admitted run ends on its summary line, and a passing case owns that
  // output instead of letting it land in the suite's.
  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = () => {};
  let exitCode;
  try {
    run({ writeBaseline: findings => written.push(findings) });
    run({
      readBaseline: () => {
        reads += 1;
        return { baseline: { 'apps/mobile/src/screen.tsx': { L1: 1 } }, failure: null };
      },
    });
    exitCode = process.exitCode;
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }
  // The injected writer received this run's findings instead of the file.
  assert.equal(written.length, 1);
  assert.equal(written[0].get('apps/mobile/src/screen.tsx').get('L1').length, 1);
  // The injected reader supplied the admitted baseline, so the run passed.
  assert.equal(reads, 1);
  assert.doesNotMatch(String(exitCode ?? ''), /1/);
  // Neither seam touched the tracked baseline: the fixture has no such file.
  assert.throws(
    () => readFileSync(join(root, 'tools/nativewind/layout-baseline.json'), 'utf8'),
    /ENOENT/
  );
});
