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

// The checker reads the app's global.css for its token list and resolves
// react-native-css through apps/mobile's node_modules for the compiler
// assertions, so the fixture tree mirrors the repository layout.
const REPO = realpathSync(new URL('../..', import.meta.url).pathname);
const MOBILE_ROOT = join(REPO, 'apps/mobile');
// Every module under tools/lib the checker imports, copied into each fixture so
// the checker runs from a root that mirrors the repository layout.
const SHARED_SCANNERS = ['js-scan.mjs', 'source-files.mjs'];

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
  return root;
}

function runChecker(context, files) {
  const root = makeFixture(context, files);
  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
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

function runScreen(context, source) {
  return runChecker(context, { 'apps/mobile/src/screen.tsx': source });
}

function expectProblem(context, source, expected) {
  const result = runScreen(context, source);
  assert.equal(result.status, 1, `expected a problem, got:\n${result.stderr}`);
  assert.match(result.stderr, expected);
  return result;
}

test('accepts horizontal padding on the content container', context => {
  const result = runScreen(context, screen('<ScrollView contentContainerClassName="px-4" />'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(
    result.stdout,
    /check-classes: no dropped classes, stray raw Text or hand-built formatters/
  );
});

test('reads the container classes after an arrow-function prop', context => {
  expectProblem(
    context,
    screen('<ScrollView onScroll={() => onScroll()} className="px-4" />'),
    /screen\.tsx:3: <ScrollView> carries "px-4" on its own className/
  );
});

test('preserves container class inspection with callbacks', context => {
  expectProblem(
    context,
    screen(
      '<ScrollView onScroll={({ nativeEvent }) => nativeEvent.contentOffset.x > 0 && onScroll()} className="px-3" />'
    ),
    /screen\.tsx:3: <ScrollView> carries "px-3" on its own className/
  );
});

test('reads the container classes across attribute lines', context => {
  expectProblem(
    context,
    screen('<ScrollView', '  onScroll={() => onScroll()}', '  className="ps-2"', '/>'),
    /screen\.tsx:3: <ScrollView> carries "ps-2" on its own className/
  );
});

test('reads the container classes after a type argument', context => {
  expectProblem(
    context,
    screen('<FlatList<Row> data={rows} className="pl-2" />'),
    /screen\.tsx:3: <FlatList> carries "pl-2" on its own className/
  );
});

test('reads the container classes after an attribute comment', context => {
  expectProblem(
    context,
    screen('<ScrollView', '  // the scroll body', '  className="pr-3"', '/>'),
    /screen\.tsx:3: <ScrollView> carries "pr-3" on its own className/
  );
});

test('reads the container classes after an attribute holding a comparison', context => {
  expectProblem(
    context,
    screen('<ScrollView accessibilityLabel="a > b" className="pe-1" />'),
    /screen\.tsx:3: <ScrollView> carries "pe-1" on its own className/
  );
});

test('reads a single-quoted className', context => {
  expectProblem(
    context,
    screen("<ScrollView className='px-2' />"),
    /screen\.tsx:3: <ScrollView> carries "px-2" on its own className/
  );
});

test('reads the container classes on an Animated container', context => {
  expectProblem(
    context,
    screen('<Animated.ScrollView onScroll={() => onScroll()} className="px-2" />'),
    /screen\.tsx:3: <Animated\.ScrollView> carries "px-2" on its own className/
  );
});

test('ignores the classes of an element nested in a prop', context => {
  const result = runScreen(
    context,
    screen('<FlatList renderItem={() => <View className="px-8" />} className="flex-1" data={[]} />')
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('reports only the container classes when a prop nests a padded element', context => {
  const result = expectProblem(
    context,
    screen('<FlatList renderItem={() => <View className="px-8" />} className="px-2" data={[]} />'),
    /screen\.tsx:3: <FlatList> carries "px-2" on its own className/
  );
  assert.doesNotMatch(result.stderr, /px-8/);
});

function themeTokens() {
  const css = readFileSync(join(MOBILE_ROOT, 'src/global.css'), 'utf8');
  const block = css.match(/@theme inline \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'global.css keeps an @theme inline block');
  return [...block.matchAll(/--color-([a-z0-9-]+):\s*var\(--/g)].map(m => m[1]);
}

test('flags all-side padding on a scroll container own className but not on contentContainerClassName', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx': 'export const a = <ScrollView className="p-4" />;\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<ScrollView> carries "p-4" on its own className/);
});

test('accepts all-side padding moved to contentContainerClassName', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      'export const a = <ScrollView contentContainerClassName="p-4" />;\n',
  });
  assert.equal(result.status, 0);
});

test('reads padding from a cn() className expression on a scroll container', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      'export const a = (\n' +
      '  <FlashList\n' +
      '    data={data}\n' +
      '    renderItem={({ item }) => <View className="px-4" />}\n' +
      "    className={cn('flex-1', selected && 'p-2')}\n" +
      '  />\n' +
      ');\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<FlashList> carries "p-2" on its own className/);
  assert.doesNotMatch(result.stderr, /px-4/);
});

test('reads padding from a template-literal className on a scroll container', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      "export const a = <ScrollView className={`flex-1 px-4 ${wide ? 'p-6' : ''}`} />;\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<ScrollView> carries "p-6 px-4" on its own className/);
});

test('accepts padding on a contentContainerClassName expression', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      "export const a = <ScrollView className=\"flex-1\" contentContainerClassName={cn('px-6', 'pt-4')} />;\n",
  });
  assert.equal(result.status, 0);
});

test('flags Intl formatters built with or without new', context => {
  const result = runChecker(context, {
    'apps/mobile/src/format.ts':
      "export const a = Intl.DateTimeFormat('en-US');\n" +
      "export const b = Intl.NumberFormat('en-US');\n" +
      "export const c = new Intl.DateTimeFormat('en-US');\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"Intl\.DateTimeFormat\(" builds its own formatter/);
  assert.match(result.stderr, /"Intl\.NumberFormat\(" builds its own formatter/);
  assert.match(result.stderr, /"new Intl\.DateTimeFormat" builds its own formatter/);
});

test('accepts Intl type references', context => {
  const result = runChecker(context, {
    'apps/mobile/src/format.ts':
      'export const options: Intl.DateTimeFormatOptions = {};\n' +
      'export let format: Intl.NumberFormat;\n',
  });
  assert.equal(result.status, 0);
});

test('reads padding from a typed scroll container tag', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      'export const a = (\n' +
      '  <FlashList<Record<string, Row>>\n' +
      '    data={data}\n' +
      "    className={cn('flex-1', 'px-5')}\n" +
      '  />\n' +
      ');\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<FlashList> carries "px-5" on its own className/);
});

test('reads a typed tag past comments and object type arguments', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      'export const a = (\n' +
      '  <FlashList<{ id: string }>\n' +
      "    // the render's tail > and a stray } stay inside the comment\n" +
      '    renderItem={({ item }) => <View className="px-4" />}\n' +
      "    className={cn('flex-1', 'p-2')}\n" +
      '  />\n' +
      ');\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<FlashList> carries "p-2" on its own className/);
  assert.doesNotMatch(result.stderr, /px-4/);
});

test('flags an Intl constructor without call parentheses after new', context => {
  const result = runChecker(context, {
    'apps/mobile/src/format.ts':
      'export const a = new Intl.DateTimeFormat;\n' +
      "export const b = new Intl.NumberFormat\n  ('en-US');\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"new Intl\.DateTimeFormat" builds its own formatter/);
  assert.match(result.stderr, /"new Intl\.NumberFormat" builds its own formatter/);
});

test('flags an opacity modifier on primary-disabled and hair-soft', context => {
  const result = runChecker(context, {
    'apps/mobile/src/panel.ts': 'export const a = "bg-primary-disabled/50 border-hair-soft/50";\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"bg-primary-disabled\/50"/);
  assert.match(result.stderr, /"border-hair-soft\/50"/);
});

test('flags an opacity modifier on every theme token', context => {
  const tokens = themeTokens();
  assert.ok(tokens.includes('primary-disabled'));
  assert.ok(tokens.includes('hair-soft'));
  const body = tokens
    .map(token => `export const k_${token.replace(/-/g, '_')} = "bg-${token}/50";\n`)
    .join('');
  const result = runChecker(context, { 'apps/mobile/src/all-tokens.ts': body });
  assert.equal(result.status, 1);
  for (const token of tokens) {
    assert.match(result.stderr, new RegExp(`"bg-${token}/50"`));
  }
});

test('accepts theme tokens without an opacity modifier', context => {
  const result = runChecker(context, {
    'apps/mobile/src/panel.ts':
      'export const a = "bg-primary-disabled border-hair-soft bg-good-tile-bg";\n',
  });
  assert.equal(result.status, 0);
});

test('flags a runtime Text import under any name and allows the type-only forms', context => {
  const result = runChecker(context, {
    'apps/mobile/src/bare.tsx': "import { Text } from 'react-native';\n",
    'apps/mobile/src/aliased.tsx': "import { Text as RNText } from 'react-native';\n",
    'apps/mobile/src/mixed.tsx':
      "import {\n  Pressable,\n  Text as RNText,\n  type TextStyle,\n} from 'react-native';\n",
    'apps/mobile/src/type-aliased.tsx': "import { type Text as RNText } from 'react-native';\n",
    'apps/mobile/src/type-import.tsx': "import type { Text } from 'react-native';\n",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /bare\.tsx:1: imports Text from 'react-native'/);
  assert.match(result.stderr, /aliased\.tsx:1: imports Text from 'react-native'/);
  assert.match(result.stderr, /mixed\.tsx:1: imports Text from 'react-native'/);
  assert.doesNotMatch(result.stderr, /type-aliased/);
  assert.doesNotMatch(result.stderr, /type-import/);
});

test('ignores test scaffolding', context => {
  const result = runChecker(context, {
    'apps/mobile/src/components/screen.mounted.test.tsx': "import { Text } from 'react-native';\n",
    'apps/mobile/src/components/screen.mounted.test-helpers.ts':
      "import { Text } from 'react-native';\n",
    'apps/mobile/src/components/screen.test.tsx': "import { Text } from 'react-native';\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
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

test('checkSourceFile reports one file and keeps no state between calls', context => {
  const root = makeFixture(context, {
    'apps/mobile/src/screen.tsx': screen('<ScrollView className="px-4" />'),
  });
  const source = '<ScrollView className="px-4" />';
  const absolute = join(root, 'apps/mobile/src/screen.tsx');
  writeFileSync(
    join(root, 'probe.mjs'),
    [
      "import { checkSourceFile } from './tools/nativewind/check-classes.mjs';",
      `const source = ${JSON.stringify(source)};`,
      `const absolute = ${JSON.stringify(absolute)};`,
      'const first = checkSourceFile("screen.tsx", absolute, source);',
      'const second = checkSourceFile("screen.tsx", absolute, source);',
      'const clean = checkSourceFile("other.ts", absolute, "export const a = 1;");',
      'console.log(JSON.stringify({ first, second, clean }));',
    ].join('\n')
  );
  const result = spawnSync(process.execPath, [join(root, 'probe.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const { first, second, clean } = JSON.parse(result.stdout);
  assert.equal(first.length, 1);
  assert.match(first[0], /<ScrollView> carries "px-4" on its own className/);
  // A second call sees this call's problems only, and a clean file sees none.
  assert.deepEqual(second, first);
  assert.deepEqual(clean, []);
});
