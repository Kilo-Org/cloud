import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
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
const SHARED_SCANNERS = ['ast.mjs', 'entry-point.mjs', 'source-files.mjs'];

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

/**
 * A root mirroring the repository layout, for the probes and the CLI case.
 *
 * `mkdtempSync` returns a path under the platform's symlinked temporary
 * directory on macOS (`/var` → `/private/var`), and the entry-point check
 * compares the script's real path with `process.argv[1]`, so the root is
 * canonicalised: a spawned audit then recognises itself and runs.
 */
function makeFixture(context, files) {
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
function stubbedCompilerFixture(context, entrySource) {
  const root = makeFixture(context, {
    'apps/mobile/src/bans.ts': 'const b = "text-start";\n',
  });
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

for (const [name, entrySource, expected] of [
  [
    'throws at compile',
    "module.exports = { compile() { throw new Error('stubbed compiler exploded on line one'); } };\n",
    'the compiler failed on the text-align: start fixture (stubbed compiler exploded on line one)',
  ],
  [
    'returns a warnings value with no text-align',
    'module.exports = { compile() { return { warnings() { return undefined; } }; } };\n',
    'text-align: start is no longer dropped — drop the text-start/end rule',
  ],
  [
    'throws at stylesheet',
    "module.exports = { compile() { return { warnings() { return ['text-align']; }, stylesheet() { throw new Error('stylesheet boom first line'); } }; } };\n",
    'the compiler failed on the color-mix over an @theme inline variable fixture (stylesheet boom first line)',
  ],
]) {
  test(`reports compiler pins the stub ${name}, keeping the source findings`, context => {
    const root = stubbedCompilerFixture(context, entrySource);
    const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    // The source-tree findings made it out before the stub failed the pins.
    assert.match(result.stderr, /bans\.ts:1: "text-start" text-align: start\/end is dropped/);
    assert.match(result.stderr, new RegExp(expected.replace(/[()]/g, m => `\\${m}`)));
    assert.match(result.stderr, /check-classes: \d+ problem\(s\)/);
    assert.doesNotMatch(result.stderr, /Error:|at /);
  });
}

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

// The layout contract's rules read a className value, a cn() argument and a
// *_CLASS constant, and stand down inside the modules that own the scale.

const ALLOWLISTED = 'apps/mobile/src/components/ui/panel.tsx';
const SCREEN_FILE = 'apps/mobile/src/screen.tsx';

function layoutProblems(relative, text) {
  return check(relative, text).filter(problem => /\[L\d+\]/.test(problem));
}

test('flags arbitrary spacing outside the allowlist and passes it inside', () => {
  const found = layoutProblems(SCREEN_FILE, screen('<View className="mt-[6px]" />'));
  assert.equal(found.length, 1);
  assert.match(found[0], /screen\.tsx:3: \[L1\] "mt-\[6px\]"/);
  assert.match(found[0], /@\/lib\/layout/);
  assert.deepEqual(layoutProblems(ALLOWLISTED, screen('<View className="mt-[6px]" />')), []);
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
});

test('accepts the gutter, a narrower inset and the modules that own one', () => {
  assert.deepEqual(
    layoutProblems(SCREEN_FILE, screen('<View className="px-4 gap-x-6 px-3 ps-2 mt-6" />')),
    []
  );
  assert.deepEqual(layoutProblems(ALLOWLISTED, screen('<View className="px-6 mx-8" />')), []);
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

test('flags a plain Button passed as a state action', () => {
  const found = layoutProblems(
    SCREEN_FILE,
    screen('<EmptyState icon={Inbox} title="Nothing" action={<Button onPress={add}><Text>Add</Text></Button>} />')
  );
  assert.equal(found.length, 1);
  assert.match(found[0], /\[L13\] "<Button>"/);
  assert.match(found[0], /StateAction/);

  const nested = layoutProblems(
    SCREEN_FILE,
    screen('<QueryError message="Failed" action={<View><Button onPress={retry}><Text>Retry</Text></Button></View>} />')
  );
  assert.equal(nested.length, 1);
  assert.match(nested[0], /\[L13\]/);
});

test('accepts StateAction and wrappers around it in a state action', () => {
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen('<EmptyState icon={Inbox} title="Nothing" action={<StateAction label="Add" icon={Plus} onPress={add} />} />')
    ),
    []
  );
  assert.deepEqual(
    layoutProblems(
      SCREEN_FILE,
      screen('<QueryError action={<View className="gap-3"><StateAction label="Retry" icon={RotateCcw} onPress={retry} /></View>} />')
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
