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

// The checker reads the app's global.css for its token list, parses JSX with
// the root typescript install and resolves react-native-css through
// apps/mobile's node_modules for the compiler assertions, so the fixture tree
// mirrors the repository layout and links the real node_modules in.
const REPO = realpathSync(new URL('../..', import.meta.url).pathname);
const MOBILE_ROOT = join(REPO, 'apps/mobile');

function runChecker(context, files) {
  const root = mkdtempSync(join(tmpdir(), 'check-classes-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  // Both SOURCE_DIRS entries must exist, or readdirSync throws ENOENT.
  mkdirSync(join(root, 'packages/app-shared/src'), { recursive: true });
  mkdirSync(join(root, 'tools/nativewind'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  copyFileSync(
    new URL('./check-classes.mjs', import.meta.url),
    join(root, 'tools/nativewind/check-classes.mjs')
  );
  copyFileSync(join(MOBILE_ROOT, 'src/global.css'), join(root, 'apps/mobile/src/global.css'));
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  symlinkSync(join(MOBILE_ROOT, 'node_modules'), join(root, 'apps/mobile/node_modules'), 'dir');

  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
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
