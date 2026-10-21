import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The checker resolves typescript and react-native-css through the repository's
// node_modules and scans apps/mobile/src and packages/app-shared/src, so the
// fixture mirrors that layout and links the installed dependencies in.
const REPO = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

function runChecker(context, source) {
  const root = mkdtempSync(join(tmpdir(), 'check-classes-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const files = {
    'apps/mobile/package.json': '{}\n',
    'apps/mobile/src/screen.tsx': source,
    'packages/app-shared/src/index.ts': 'export {};\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  symlinkSync(
    join(REPO, 'apps/mobile/node_modules'),
    join(root, 'apps/mobile/node_modules'),
    'dir'
  );

  // Preserve the real command and its import.meta.url-based repository layout.
  const toolDir = join(root, 'tools/nativewind');
  mkdirSync(toolDir, { recursive: true });
  copyFileSync(new URL('./check-classes.mjs', import.meta.url), join(toolDir, 'check-classes.mjs'));

  const result = spawnSync(process.execPath, [join(toolDir, 'check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
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

function expectProblem(context, source, expected) {
  const result = runChecker(context, source);
  assert.equal(result.status, 1, `expected a problem, got:\n${result.stderr}`);
  assert.match(result.stderr, expected);
  return result;
}

test('accepts horizontal padding on the content container', context => {
  const result = runChecker(context, screen('<ScrollView contentContainerClassName="px-4" />'));
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

test('ignores the classes of an element nested in a prop', context => {
  const result = runChecker(
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
