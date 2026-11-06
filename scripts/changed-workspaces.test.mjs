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

function runMatrix(fixture, base, args = [], extraEnv = {}) {
  const eventPath = join(fixture.dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base } } }));
  return run(fixture, args, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    ...extraEnv,
  });
}

// The document the changes job publishes, from this fixture's own detector.
function detectorDocument(fixture, base) {
  const result = spawnSync(
    'node',
    [join(fixture.dir, 'scripts', 'affected-workspaces.mjs'), base],
    { cwd: fixture.dir, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
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

// The changes job in ci.yml runs the detector once and publishes the document to
// the matrix step as AFFECTED. The fixture has no detector of its own, so a
// second selection attempt cannot succeed: the rows below come from the document.
test('a supplied selection for the same base decides the matrix without a second pass', t => {
  const fixture = createFixture({ withDetector: false });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();
  edit(fixture.dir, 'packages/leaf/src/index.ts', 'export const leaf = 5;\n');
  fixture.git('add', '-A');
  commit(fixture.git, 'change leaf sources with a supplied selection');

  const document = JSON.stringify({
    base,
    full: false,
    dirs: ['packages/leaf', 'packages/reader'],
  });
  const result = runMatrix(fixture, base, [], { AFFECTED: document });
  assert.doesNotMatch(result.stderr, /selecting every workspace with tests/);
  assert.match(result.stderr, /reusing the affected-workspace document/);
  assert.deepEqual(rows(JSON.parse(result.stdout)), [
    'leaf packages/leaf',
    'reader packages/reader',
  ]);

  // --exclude and --include still decide over the supplied selection.
  assert.deepEqual(
    rows(
      JSON.parse(
        runMatrix(fixture, base, ['--exclude', 'packages/leaf'], { AFFECTED: document }).stdout
      )
    ),
    ['reader packages/reader']
  );
  assert.deepEqual(
    rows(
      JSON.parse(
        runMatrix(fixture, base, ['--include', 'packages/tool'], {
          AFFECTED: JSON.stringify({ base, full: false, dirs: [] }),
        }).stdout
      )
    ),
    ['tool packages/tool']
  );
});

test('a selection computed for another base is ignored', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();
  edit(fixture.dir, 'packages/leaf/src/index.ts', 'export const leaf = 6;\n');
  fixture.git('add', '-A');
  commit(fixture.git, 'change leaf sources with a stale document');

  // The document names another revision and selects only `tool`: the real diff
  // must decide the rows instead.
  const result = runMatrix(fixture, base, [], {
    AFFECTED: JSON.stringify({ base: 'a'.repeat(40), full: false, dirs: ['packages/tool'] }),
  });
  assert.doesNotMatch(result.stderr, /reusing the affected-workspace document/);
  assert.deepEqual(rows(JSON.parse(result.stdout)), [
    'leaf packages/leaf',
    'reader packages/reader',
  ]);
});

test('an unreadable supplied selection keeps the detector and fallback paths', t => {
  const fixture = createFixture({ withDetector: false });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();
  edit(fixture.dir, 'packages/leaf/src/index.ts', 'export const leaf = 7;\n');
  fixture.git('add', '-A');
  commit(fixture.git, 'change leaf sources with an unreadable document');

  for (const affected of ['{"broken":', JSON.stringify({ base })]) {
    const result = runMatrix(fixture, base, [], { AFFECTED: affected });
    assert.match(result.stderr, /selecting every workspace with tests/, affected);
    assert.deepEqual(rows(JSON.parse(result.stdout)), [
      'leaf packages/leaf',
      'reader packages/reader',
      'tool packages/tool',
    ]);
  }
});

test('a document without a directory array keeps the fallback path', t => {
  const fixture = createFixture({ withDetector: false });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();

  // `has("dirs")` alone would pass this document, and a reuse attempt would
  // fail the step instead of selecting.
  const result = runMatrix(fixture, base, [], {
    AFFECTED: JSON.stringify({ base, full: false, dirs: null }),
  });
  assert.doesNotMatch(result.stderr, /reusing the affected-workspace document/);
  assert.match(result.stderr, /selecting every workspace with tests/);
  assert.deepEqual(rows(JSON.parse(result.stdout)), [
    'leaf packages/leaf',
    'reader packages/reader',
    'tool packages/tool',
  ]);
});

test('an empty selection for the same base selects no rows', t => {
  const fixture = createFixture({ withDetector: false });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();

  const result = runMatrix(fixture, base, [], {
    AFFECTED: JSON.stringify({ base, full: false, dirs: [] }),
  });
  assert.doesNotMatch(result.stderr, /selecting every workspace with tests/);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('the supplied document yields the same matrix as a fresh selection', t => {
  const fixture = createFixture();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const base = fixture.head();
  edit(fixture.dir, 'packages/leaf/src/index.ts', 'export const leaf = 8;\n');
  fixture.git('add', '-A');
  commit(fixture.git, 'change leaf sources for both paths');

  const document = detectorDocument(fixture, base);
  assert.equal(JSON.parse(document).base, base);
  const supplied = runMatrix(fixture, base, [], { AFFECTED: document });
  assert.match(supplied.stderr, /reusing the affected-workspace document/);
  assert.deepEqual(
    rows(JSON.parse(supplied.stdout)),
    rows(JSON.parse(runMatrix(fixture, base).stdout))
  );
});
