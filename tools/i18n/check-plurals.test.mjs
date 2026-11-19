import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import test, { after } from 'node:test';

import {
  auditCountedCalls,
  checkDynamicCountedKeySources,
  collectCountedKeys,
  collectDynamicCountedCalls,
  DYNAMIC_COUNTED_KEYS,
  findCountlessFamilies,
  findUnlistedDynamicCalls,
  readEnglishCatalog,
} from './check-plurals.mjs';

// The checker parses with oxc through the shared scanner, so the command
// fixtures link the repository's dependency tree at their own root.
const REPO = realpathSync(new URL('../..', import.meta.url).pathname);
const SHARED_MODULES = ['ast.mjs', 'catalogs.mjs', 'entry-point.mjs', 'source-files.mjs'];
// The checker the command fixtures run, read once so a copy is always the text
// this suite's assertions were written against.
const CHECKER_SOURCE = readFileSync(new URL('./check-plurals.mjs', import.meta.url), 'utf8');

const PLURAL_ENGLISH = {
  agents: {
    liveCount_one: '{{count}} live session',
    liveCount_other: '{{count}} live sessions',
  },
};

// One parent directory for the whole file: each case writes its files into a
// directory of its own, so a case never sees another case's tree.
const FIXTURES = mkdtempSync(join(tmpdir(), 'check-plurals-'));
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

/** Write `files` into a fresh directory under the fixture parent, and return it. */
function fixture(files) {
  const root = mkdtempSync(join(FIXTURES, 'case-'));
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

/**
 * A fixture tree that can run the checker as CI does: a copy of the checker
 * and the shared modules below its own `tools/`, and the repository's installed
 * dependencies linked at its root. The checker reads its root from its own
 * location, so the copy audits this tree.
 */
function cliFixture(files) {
  const root = fixture({ ...files, 'tools/i18n/check-plurals.mjs': CHECKER_SOURCE });
  mkdirSync(join(root, 'tools/lib'), { recursive: true });
  for (const name of SHARED_MODULES) {
    copyFileSync(new URL(`../lib/${name}`, import.meta.url), join(root, `tools/lib/${name}`));
  }
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

function cli(root) {
  const result = spawnSync(process.execPath, [join(root, 'tools/i18n/check-plurals.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

/**
 * The declaration the checker mirrors, written as the app writes it: the two
 * `…Key` declarations are unions, and the three key maps are const objects with
 * one string per key. The keys come from the checker's own list, so a fixture
 * cannot drift from the declarations it stands in for — and every module under
 * the source root must exist, or the run reports it unreadable.
 */
function declarationFiles() {
  const byFile = new Map();
  for (const { keys, source, declaration } of DYNAMIC_COUNTED_KEYS.values()) {
    let declarations = byFile.get(source);
    if (declarations === undefined) {
      declarations = new Map();
      byFile.set(source, declarations);
    }
    declarations.set(declaration, keys);
  }
  const files = {};
  for (const [source, declarations] of byFile) {
    files[source] = [...declarations].map(renderDeclaration).join('\n');
  }
  return files;
}

function renderDeclaration([name, keys]) {
  const members = keys.map(key => `'${key}'`);
  if (name.endsWith('Key')) {
    return `export type ${name} =\n  | ${members.join('\n  | ')};`;
  }
  const entries = members.map((member, index) => `  k${index}: ${member},`);
  return `export const ${name} = {\n${entries.join('\n')}\n};`;
}

const DECLARATIONS = declarationFiles();

/**
 * The standard fixture files. `broken` replaces `mcp-settings-state.ts` with
 * text the parser refuses, which is the failure both reads of the declaration
 * modules used to report once each.
 */
function standardFiles({ source = '', english = {}, broken = false } = {}) {
  return {
    ...DECLARATIONS,
    'apps/mobile/src/i18n/locales/en.json': JSON.stringify(english),
    'apps/mobile/src/example.ts': source,
    ...(broken ? { 'apps/mobile/src/components/chat/mcp-settings-state.ts': 'const a = ;\n' } : {}),
  };
}

test('reports a refused declaration module once, from the source-tree scan', () => {
  const root = fixture(standardFiles({ broken: true }));
  const scan = auditCountedCalls(root);
  // The source root holds the declaration modules, so its scan reads the file
  // and owns the parse diagnostic.
  assert.match(scan.problems.join('\n'), /mcp-settings-state\.ts:1: cannot parse: /);
  assert.equal(scan.problems.length, 1);
  // The declaration check re-reads the same module through the same parse step,
  // so the identical line reaches it; the caller's scan already reported it.
  assert.deepEqual(checkDynamicCountedKeySources(root, new Set(scan.problems)), []);
  // Called alone, with nothing reported yet, the check still names the file.
  const alone = checkDynamicCountedKeySources(root);
  assert.equal(alone.length, 1);
  assert.match(alone[0], /mcp-settings-state\.ts:1: cannot parse: /);
});

test('reports one problem through the command for one refused declaration module', () => {
  const root = cliFixture(standardFiles({ broken: true }));
  const result = cli(root);
  assert.equal(result.status, 1);
  const parseLines = result.stderr
    .split('\n')
    .filter(line => /mcp-settings-state\.ts:\d+: cannot parse: /.test(line));
  assert.equal(parseLines.length, 1, `expected one parse line, got:\n${result.stderr}`);
  assert.match(result.stderr, /check-plurals: 1 problem\(s\)/);
  // A module whose parse failed has no declaration to read, so the per-key
  // mismatch lines stay suppressed instead of burying the parse line.
  assert.doesNotMatch(result.stderr, /is not declared in this module/);
});

test('accepts a healthy tree through the command', () => {
  const root = cliFixture(
    standardFiles({
      source: "t('agents.liveCount', { count: 2 });",
      english: PLURAL_ENGLISH,
    })
  );
  const result = cli(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-plurals: every counted message declares a plural family/);
});

test('reports an unreadable English catalog and judges no family against it', () => {
  const root = fixture(standardFiles({ source: "t('agents.liveCount', { count: 2 });" }));
  const locales = join(root, 'apps/mobile/src/i18n/locales');
  rmSync(join(locales, 'en.json'));
  mkdirSync(join(locales, 'en.json'));
  const read = readEnglishCatalog(locales);
  assert.equal(read.catalog, null);
  assert.equal(read.problems.length, 1, read.problems.join('\n'));
  assert.match(read.problems[0], /^en: cannot audit catalog: EISDIR/);
  // Without English there is no family to judge the key against, so the key
  // must not be reported countless on top of the one line naming the cause.
  const scan = auditCountedCalls(root);
  assert.deepEqual(findCountlessFamilies(scan, read.catalog), []);
});

test('reports an unreadable English catalog through the command and keeps the scan findings', () => {
  const root = cliFixture(standardFiles({ source: 't(dynamicKey, { count: 1 });' }));
  const locales = join(root, 'apps/mobile/src/i18n/locales');
  rmSync(join(locales, 'en.json'));
  mkdirSync(join(locales, 'en.json'));
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^en: cannot audit catalog: EISDIR/m);
  assert.match(result.stderr, /counted call with variable key "dynamicKey"/);
  assert.doesNotMatch(result.stderr, /^\s+at /m);
});

test('reports a malformed English catalog through the command and keeps the scan findings', () => {
  const root = cliFixture(standardFiles({ source: 't(dynamicKey, { count: 1 });' }));
  writeFileSync(join(root, 'apps/mobile/src/i18n/locales/en.json'), '{"agents": ');
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^en: cannot audit catalog: /m);
  assert.match(result.stderr, /counted call with variable key "dynamicKey"/);
  // The JSON parse message itself reads "at position 12", so only a stack
  // frame line is the symptom this case rules out.
  assert.doesNotMatch(result.stderr, /^\s+at /m);
});

test('reports an unreadable file through the command and invents no key for it', context => {
  // The read refusal must reach the problem list, or the command ends on a
  // stack trace and loses the scan it had already made.
  if (process.getuid?.() === 0) {
    context.skip('root reads any file, so chmod 000 leaves it readable');
    return;
  }
  const root = cliFixture({
    ...standardFiles(),
    'apps/mobile/src/locked.ts': 'export const c = 1;\n',
  });
  const locked = join(root, 'apps/mobile/src/locked.ts');
  chmodSync(locked, 0o000);
  try {
    const result = cli(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /locked\.ts: cannot read: /);
    // The unreadable file yields the read line only: no counted key and no
    // declaration line can come out of text nobody read.
    assert.match(result.stderr, /check-plurals: 1 problem\(s\)/);
    assert.doesNotMatch(result.stderr, /locked\.ts:\d+:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    chmodSync(locked, 0o644);
  }
});

test('reports an unreadable declaration module once through the command', context => {
  // The scan and the declaration check both read the module; one wording for
  // both means the second read's line is dropped, not printed beside the
  // first.
  if (process.getuid?.() === 0) {
    context.skip('root reads any file, so chmod 000 leaves it readable');
    return;
  }
  const root = cliFixture(standardFiles());
  const locked = join(root, [...DYNAMIC_COUNTED_KEYS.values()][0].source);
  chmodSync(locked, 0o000);
  try {
    const result = cli(root);
    assert.equal(result.status, 1, result.stderr);
    const readLines = result.stderr.split('\n').filter(line => /cannot read/.test(line));
    assert.equal(readLines.length, 1, `expected one cannot-read line, got:\n${result.stderr}`);
    assert.match(readLines[0], /: cannot read: /);
    assert.match(result.stderr, /check-plurals: 1 problem\(s\)/);
  } finally {
    chmodSync(locked, 0o644);
  }
});

test('reports an unreadable declaration module once from the declaration check', context => {
  if (process.getuid?.() === 0) {
    context.skip('root reads any file, so chmod 000 leaves it readable');
    return;
  }
  const root = fixture(standardFiles());
  const locked = join(root, [...DYNAMIC_COUNTED_KEYS.values()][0].source);
  chmodSync(locked, 0o000);
  try {
    const problems = checkDynamicCountedKeySources(root);
    // Called alone, with nothing reported yet, the check still names the file —
    // in the walk's wording, so a caller that scanned the tree can drop it.
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /: cannot read: /);
  } finally {
    chmodSync(locked, 0o644);
  }
});

test('projects one scan into sorted keys, unlisted calls and countless families', () => {
  const root = fixture(
    standardFiles({
      source: [
        `t('zeta.count', { count: 1 });`,
        `t('alpha.count', { count: 1 });`,
        `t(zetaKey, { count: 1 });`,
        `t(alphaKey, { count: 1 });`,
      ].join('\n'),
    })
  );
  const scan = auditCountedCalls(root);
  assert.deepEqual(collectCountedKeys(scan), ['alpha.count', 'zeta.count']);
  assert.deepEqual(collectDynamicCountedCalls(scan), ['alphaKey', 'zetaKey']);
  assert.deepEqual(findUnlistedDynamicCalls(scan), ['alphaKey', 'zetaKey']);
  // The caller's catalog is checked as given, so a complete family clears its
  // key while the rest keep the sorted order.
  assert.deepEqual(findCountlessFamilies(scan, new Map()), ['alpha.count', 'zeta.count']);
  assert.deepEqual(
    findCountlessFamilies(
      scan,
      new Map([
        ['alpha.count_one', 'x'],
        ['alpha.count_other', 'y'],
      ])
    ),
    ['zeta.count']
  );
});
