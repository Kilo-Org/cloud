import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

// A workspace with a test script and a test file decides a matrix row; every
// other workspace keeps its files but stays out. `reader` reads `leaf` through
// the workspace protocol, so a leaf change selects it too.
const packages = {
  leaf: {
    manifest: { name: 'leaf', scripts: { test: 'node -e 0' } },
    files: {
      'src/index.ts': 'export const leaf = 1;\n',
      'src/index.test.ts': 'test("leaf", () => {});\n',
    },
  },
  reader: {
    manifest: {
      name: 'reader',
      scripts: { test: 'node -e 0' },
      dependencies: { leaf: 'workspace:*' },
    },
    files: {
      'src/index.ts': 'import { leaf } from "leaf";\n',
      'src/reader.test.ts': 'test("reader", () => {});\n',
    },
  },
  'no-test-script': {
    manifest: { name: 'no-test-script' },
    files: { 'src/no-test-script.test.ts': 'test("x", () => {});\n' },
  },
  'no-test-file': {
    manifest: { name: 'no-test-file', scripts: { test: 'node -e 0' } },
    files: { 'src/index.ts': 'export const x = 1;\n' },
  },
  tool: {
    manifest: { name: 'tool', scripts: { test: 'node -e 0' } },
    files: { 'src/tool.test.ts': 'test("tool", () => {});\n' },
  },
};

function createFixture({ withDetector = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'changed-workspaces-'));
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "fixture-root",\n  "private": true\n}\n');
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  if (withDetector) {
    cpSync(
      join(repo, 'scripts', 'affected-workspaces.mjs'),
      join(dir, 'scripts', 'affected-workspaces.mjs')
    );
  }
  mkdirSync(join(dir, 'docs'), { recursive: true });
  for (const [name, pkg] of Object.entries(packages)) {
    const pkgDir = join(dir, 'packages', name);
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(pkg.manifest, null, 2)}\n`);
    for (const [file, content] of Object.entries(pkg.files)) {
      writeFileSync(join(pkgDir, file), content);
    }
  }
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  git('add', '-A');
  commit(git, 'initial');
  return { dir, git, head: () => git('rev-parse', 'HEAD').stdout.trim() };
}

function commit(git, message) {
  const result = git(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-aqm',
    message
  );
  assert.equal(result.status, 0, result.stderr);
}

function edit(dir, file, content) {
  writeFileSync(join(dir, file), content);
}

function runMatrix(fixture, base, args = []) {
  const eventPath = join(fixture.dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base } } }));
  return run(fixture, args, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath });
}

// No GitHub event and no origin remote: the script has no base revision, so the
// detector answers with every workspace.
function runWithoutBase(fixture, args = []) {
  return run(fixture, args, { GITHUB_EVENT_NAME: '', GITHUB_EVENT_PATH: '' });
}

function run(fixture, args, extraEnv) {
  const result = spawnSync('bash', [join(repo, 'scripts', 'changed-workspaces.sh'), ...args], {
    cwd: fixture.dir,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const rows = matrix => matrix.map(row => `${row.name} ${row.dir}`).sort();
const sorted = entries => [...entries].sort();

test('a change selects the changed workspace and its reader', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();
  edit(fixture.dir, 'packages/leaf/src/index.ts', 'export const leaf = 2;\n');
  fixture.git('add', '-A');
  commit(fixture.git, 'change leaf sources');

  const result = runMatrix(fixture, base);
  assert.deepEqual(rows(JSON.parse(result.stdout)), [
    'leaf packages/leaf',
    'reader packages/reader',
  ]);
});

test('a document change selects nothing and an include dir still runs', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();
  edit(fixture.dir, 'docs/a.md', '# a document\n');
  fixture.git('add', '-A');
  commit(fixture.git, 'change a document');

  assert.deepEqual(rows(JSON.parse(runMatrix(fixture, base).stdout)), []);
  assert.deepEqual(
    rows(JSON.parse(runMatrix(fixture, base, ['--include', 'packages/tool']).stdout)),
    ['tool packages/tool']
  );
});

test('excludes and the test-script and test-file requirements decide the rows', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();
  edit(fixture.dir, 'packages/leaf/src/index.ts', 'export const leaf = 3;\n');
  fixture.git('add', '-A');
  commit(fixture.git, 'change leaf sources again');

  assert.deepEqual(
    rows(JSON.parse(runMatrix(fixture, base, ['--exclude', 'packages/reader']).stdout)),
    ['leaf packages/leaf']
  );
  // The requirements hold exactly: a workspace without a test script and a
  // workspace without a test file are not rows, selected or not.
  const every = JSON.parse(
    runMatrix(fixture, base, [
      '--include',
      'packages/no-test-script',
      '--include',
      'packages/no-test-file',
    ]).stdout
  );
  assert.deepEqual(rows(every), ['leaf packages/leaf', 'reader packages/reader']);
  assert.equal(sorted(every.map(row => row.dir)).includes('packages/no-test-script'), false);
  assert.equal(sorted(every.map(row => row.dir)).includes('packages/no-test-file'), false);
});

test('without a base revision the matrix covers every workspace with tests', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  assert.deepEqual(rows(JSON.parse(runWithoutBase(fixture).stdout)), [
    'leaf packages/leaf',
    'reader packages/reader',
    'tool packages/tool',
  ]);
});

test('without detector output the matrix covers every workspace with tests', t => {
  const fixture = createFixture({ withDetector: false });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();
  edit(fixture.dir, 'packages/leaf/src/index.ts', 'export const leaf = 4;\n');
  fixture.git('add', '-A');
  commit(fixture.git, 'change leaf sources without detector');

  const result = runMatrix(fixture, base);
  assert.match(result.stderr, /selecting every workspace with tests/);
  assert.deepEqual(rows(JSON.parse(result.stdout)), [
    'leaf packages/leaf',
    'reader packages/reader',
    'tool packages/tool',
  ]);
});
