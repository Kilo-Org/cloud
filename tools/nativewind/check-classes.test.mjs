import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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

import { checkParsedFile } from './check-classes.mjs';
import { parseSourceEntry } from '../lib/source-files.mjs';

// The rule cases read the repository's own files: the checker resolves the app's
// global.css token list from its own location, so nothing has to be copied. The
// probes and the CLI case need a root that mirrors the repository layout, and
// they build one.
const REPO = realpathSync(new URL('../..', import.meta.url).pathname);
const MOBILE_ROOT = join(REPO, 'apps/mobile');
const SHARED_SCANNERS = ['ast.mjs', 'source-files.mjs'];

/**
 * The diagnostics of one file, straight from the checker's own export. A
 * fixture's text is passed directly, and the absolute path names the
 * repository's app tree because the Intl rule decides by it whether the
 * formatter rule applies; the shared parse entry reads nothing from that path
 * but the text it is given.
 */
function check(relative, text) {
  return checkParsedFile(parseSourceEntry(MOBILE_ROOT, REPO, join(REPO, relative), text));
}

/** The diagnostics of several files, in the order they are listed. */
function checkAll(files) {
  return Object.entries(files).flatMap(([relative, text]) => check(relative, text));
}

/** A root mirroring the repository layout, for the probes and the CLI case. */
function makeFixture(context, files) {
  const root = mkdtempSync(join(tmpdir(), 'check-classes-'));
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
  copyFileSync(join(MOBILE_ROOT, 'src/global.css'), join(root, 'apps/mobile/src/global.css'));
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
        '<FlatList renderItem={() => <View className="px-8" />} className="flex-1" data={[]} />'
      )
    ),
    []
  );
});

test('reports only the container classes when a prop nests a padded element', () => {
  const found = expectProblem(
    screen('<FlatList renderItem={() => <View className="px-8" />} className="px-2" data={[]} />'),
    /screen\.tsx:3: <FlatList> carries "px-2" on its own className/
  );
  assert.doesNotMatch(found.join('\n'), /px-8/);
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
      "export const a = <ScrollView className=\"flex-1\" contentContainerClassName={cn('px-6', 'pt-4')} />;\n"
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
      "import { checkParsedFile } from './tools/nativewind/check-classes.mjs';",
      "import { parseSourceEntry } from './tools/lib/source-files.mjs';",
      `const source = ${JSON.stringify(source)};`,
      `const absolute = ${JSON.stringify(absolute)};`,
      `const dir = ${JSON.stringify(dir)};`,
      `const root = ${JSON.stringify(root)};`,
      'const entry = parseSourceEntry(dir, root, absolute, source);',
      'const first = checkParsedFile(entry);',
      'const firstAgain = checkParsedFile(entry);',
      'const clean = checkParsedFile(parseSourceEntry(dir, root, absolute, "export const a = 1;"));',
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
      'const b = "text-start";\n' +
      'const c = 2;\n' +
      'const d = "ltr: leading-9";\n' +
      '/* "bg-primary/50" in the rule comment is documentation\n' +
      ' * text-start in a block-comment body */\n'
  );
  assert.deepEqual(found, [
    `apps/mobile/src/bans.ts:3: "text-start" text-align: start/end is dropped; the shared Text handles RTL alignment already`,
    `apps/mobile/src/bans.ts:5: "ltr:" the ltr: variant also matches in RTL; express the rule with rtl: instead`,
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
    `apps/mobile/src/bans.ts:1: "text-start" text-align: start/end is dropped; the shared Text handles RTL alignment already`,
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
