import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

import { flattenCatalog, missingPluralCategories } from '../lib/catalogs.mjs';
import { checkCatalogs } from './check-catalogs.mjs';

// The checker parses with oxc through the shared scanner, so the import-only
// probe links the repository's dependency tree at its own root.
const REPO = realpathSync(new URL('../..', import.meta.url).pathname);
const SHARED_MODULES = [
  'ast.mjs',
  'catalogs.mjs',
  'entry-point.mjs',
  'fs-entries.mjs',
  'source-files.mjs',
];
const WORDING_EXCEPTIONS = readFileSync(
  new URL('./wording-exceptions.json', import.meta.url),
  'utf8'
);
// The checker the command fixtures run, read once so a case can hand over a
// patched copy of the same text.
const CHECKER_SOURCE = readFileSync(new URL('./check-catalogs.mjs', import.meta.url), 'utf8');

const ENGLISH = {
  agents: {
    title: 'Agents',
    liveCount_one: '{{count}} live session',
    liveCount_other: '{{count}} live sessions',
  },
};
const TRANSLATED = {
  agents: {
    title: 'Localized agents',
    liveCount_one: '{{count}} localized session',
    liveCount_few: '{{count}} localized sessions (few)',
    liveCount_many: '{{count}} localized sessions (many)',
    liveCount_other: '{{count}} localized sessions',
  },
};
const SOURCE = "t('agents.title');\nt('agents.liveCount', { count: 2 });";

// Hindi selects only `one` and `other`, so a fixture catalog for it declares
// those two forms and nothing else: a form Hindi cannot select is now a
// reported problem of its own.
const HINDI_TRANSLATED = {
  agents: {
    title: 'स्थानीयकृत एजेंट',
    liveCount_one: '{{count}} स्थानीयकृत सत्र',
    liveCount_other: '{{count}} स्थानीयकृत सत्र',
  },
};

// Thai selects only `other`, so its fixture catalog carries that one form.
const THAI_TRANSLATED = {
  agents: {
    title: 'เอเจนต์ที่แปลแล้ว',
    liveCount_other: '{{count}} เซสชันที่แปลแล้ว',
  },
};

// One parent directory for the whole file: each case writes its files into a
// directory of its own, so a case never sees another case's catalogs.
const FIXTURES = mkdtempSync(join(tmpdir(), 'check-catalogs-'));
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
 * The audit over a fixture tree, in this process. `root` is a directory
 * argument to the audit itself, so the tree holds no copy of the checker and
 * links nothing: only the files the audit reads.
 */
function run({
  english = ENGLISH,
  translated = TRANSLATED,
  source = SOURCE,
  language = 'ru',
  pushEnglish = {},
  pushTranslated = {},
  pushSource = '',
  wordingExceptions = WORDING_EXCEPTIONS,
  extraFiles = {},
  afterWrite = null,
} = {}) {
  const root = fixture({
    'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = ['en', '${language}'];`,
    'apps/mobile/src/example.ts': source,
    'apps/mobile/src/i18n/locales/en.json': JSON.stringify(english),
    [`apps/mobile/src/i18n/locales/${language}.json`]: JSON.stringify(translated),
    'packages/notifications/src/locales/en.json': JSON.stringify(pushEnglish),
    [`packages/notifications/src/locales/${language}.json`]: JSON.stringify(pushTranslated),
    'packages/notifications/src/push-copy.ts': pushSource,
    // The push locale module the catalog checker reads: one import and one
    // registry entry per fixture catalog, as the real module writes them.
    'packages/notifications/src/i18n.ts': [
      `import en from './locales/en.json';`,
      `import ${language.replaceAll('-', '_')} from './locales/${language}.json';`,
      `const pushCatalogs = { 'en': en, '${language}': ${language.replaceAll('-', '_')} };`,
    ].join('\n'),
    ...(wordingExceptions === null
      ? {}
      : { 'tools/i18n/wording-exceptions.json': wordingExceptions }),
    ...extraFiles,
  });
  // A case that needs a mode the tree cannot hold — a file the filesystem
  // refuses to read — changes it here, after the write and before the audit.
  // A hook that returns a function gets it called after the audit, so the case
  // can put the mode back before the fixture cleanup deletes the tree.
  const restore = afterWrite === null ? null : afterWrite(root);
  try {
    return checkCatalogs(root).problems;
  } finally {
    restore?.();
  }
}

/**
 * A fixture tree that can run the checker as CI does: a copy of the checker,
 * its shared modules and its wording exceptions, and the repository's
 * dependency tree linked at the root the command resolves from. `checker`
 * replaces the checker's source text, for a case that runs a patched copy.
 */
function cliFixture(files, checker = CHECKER_SOURCE) {
  const root = fixture({
    ...files,
    'tools/i18n/check-catalogs.mjs': checker,
    'tools/i18n/wording-exceptions.json': WORDING_EXCEPTIONS,
  });
  mkdirSync(join(root, 'tools/lib'), { recursive: true });
  for (const name of SHARED_MODULES) {
    copyFileSync(new URL(`../lib/${name}`, import.meta.url), join(root, `tools/lib/${name}`));
  }
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

/** The standard fixture files, for a tree that runs the command. */
function standardFiles({ english = ENGLISH, translated = TRANSLATED, source = SOURCE } = {}) {
  return {
    'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = ['en', 'ru'];`,
    'apps/mobile/src/example.ts': source,
    // The push catalog's second source root. A command tree's root IS the
    // repository root inside the copied checker, so a root absent here is the
    // strict case: the audit has to have every declared source tree.
    'services/example.ts': "export const pushExample = 'Example';",
    'apps/mobile/src/i18n/locales/en.json': JSON.stringify(english),
    'apps/mobile/src/i18n/locales/ru.json': JSON.stringify(translated),
    'packages/notifications/src/locales/en.json': '{}',
    'packages/notifications/src/locales/ru.json': '{}',
    'packages/notifications/src/i18n.ts': [
      `import en from './locales/en.json';`,
      `import ru from './locales/ru.json';`,
      `const pushCatalogs = { 'en': en, 'ru': ru };`,
    ].join('\n'),
  };
}

function cli(root) {
  const result = spawnSync(process.execPath, [join(root, 'tools/i18n/check-catalogs.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

/** A streamed read has no built-in deadline, so the helper sets one. */
const CHILD_TIMEOUT_MS = 60_000;

/**
 * The command with its stderr read while it runs, as a pipeline consumer reads
 * it. `spawnSync` drains every write as it blocks, so only this shape shows a
 * report that the command abandons when it exits: the pipe holds one buffer.
 * The reader owns the wait, so the child needs its own limit: a command that
 * never exits would otherwise hold the test run open forever.
 */
function cliStreamed(root, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'tools/i18n/check-catalogs.mjs')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the command did not exit within ${CHILD_TIMEOUT_MS} ms`));
    }, CHILD_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

for (const callee of ['t', 'i18n.t']) {
  test(`accepts a plural base called through ${callee} with English siblings`, () => {
    const found = run({
      source: `t('agents.title');\n${callee}('agents.liveCount', { count: 2 });`,
    });
    assert.deepEqual(found, []);
  });
}

test('accepts an exact source key without plural siblings', () => {
  const found = run({
    english: { agents: { title: 'Agents' } },
    translated: { agents: { title: 'Localized agents' } },
    source: "t('agents.title');",
  });
  assert.deepEqual(found, []);
});

for (const [name, call, key] of [
  ['a missing unrelated source key', "t('profile.missing');", 'profile.missing'],
  ['a nonexistent plural family', "t('agents.missingCount', { count: 2 });", 'agents.missingCount'],
]) {
  test(`rejects ${name}`, () => {
    const found = run({ source: `${SOURCE}\n${call}` });
    assert.ok(found.length > 0, 'expected a problem');
    assert.ok(
      found.join('\n').includes(`mobile: source uses "${key}", which en.json does not define`)
    );
  });
}

test('rejects a missing translated English key', () => {
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.title;
  const found = run({ translated });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: missing key "agents\.title"/);
});

test('rejects a missing required locale plural category', () => {
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.liveCount_few;
  const found = run({ translated });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: plural family "agents\.liveCount" lacks the few category of ru/
  );
});

test('still requires a zero form in a language that selects zero', () => {
  // Arabic selects the zero category itself, so its families owe a `_zero`
  // form. The required list must not drop that category on the way to matching
  // the runtime's own categories: i18next's count-zero lookup is an override
  // for the languages that do not select zero, not a reason to stop asking.
  const found = run({
    language: 'ar',
    translated: {
      agents: {
        title: 'وكلاء محليون',
        liveCount_one: '{{count}} جلسة محلية',
        liveCount_two: 'جلستان محليتان',
        liveCount_few: '{{count}} جلسات محلية',
        liveCount_many: '{{count}} جلسة محلية',
        liveCount_other: '{{count}} جلسة محلية',
      },
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ar: plural family "agents\.liveCount" lacks the zero category of ar/
  );
});

test('rejects a plural category the locale can never select', () => {
  // Japanese selects only `other`, so i18next never asks it for `_one`. This
  // form repeats its family's `other` text, so removing it cannot change what
  // a reader sees, and the rule reports it.
  const found = run({
    language: 'ja',
    translated: {
      agents: {
        title: 'エージェント',
        liveCount_one: '{{count}}件のセッション',
        liveCount_other: '{{count}}件のセッション',
      },
    },
  });
  assert.match(
    found.join('\n'),
    /mobile\/ja: plural family "agents\.liveCount" declares a one form that ja never selects/
  );
});

test('keeps a form the locale cannot select when its copy is its own', () => {
  // The form has text its `other` sibling does not share. A runtime that
  // selects it would render different copy, so the rule must leave it alone:
  // only a form that repeats its family's `other` text is provably safe to
  // remove from the catalogs alone.
  const found = run({
    language: 'ja',
    translated: {
      agents: {
        title: 'エージェント',
        liveCount_one: '{{count}}件だけです',
        liveCount_other: '{{count}}件のセッション',
      },
    },
  });
  assert.deepEqual(found, []);
});

test('admits a zero form the plural rule cannot select', () => {
  // i18next looks `_zero` up by itself at count 0, so Japanese may carry one
  // even though its plural rule never selects that category.
  const found = run({
    language: 'ja',
    translated: {
      agents: {
        title: 'エージェント',
        liveCount_zero: '{{count}}件のセッション',
        liveCount_other: '{{count}}件のセッション',
      },
    },
  });
  assert.deepEqual(found, []);
});

test('admits a form the shipped plural data selects', () => {
  // Vietnamese is the case that makes the truth source matter: the app bundles
  // FormatJS plural data that selects `one` at a count of one, while a host on
  // a newer CLDR reports `other` only. Judging by the host's ICU would call the
  // Vietnamese singular dead and delete live copy, so the catalog keeps it.
  //
  // The tree links the repository's own loader map and polyfill data, because
  // those are exactly what the rule reads: a fixture without them falls back to
  // the host's rules and cannot test this case.
  const root = fixture({
    'apps/mobile/src/i18n/languages.ts': "export const SUPPORTED_LANGUAGES = ['en', 'vi'];",
    'apps/mobile/src/example.ts': SOURCE,
    'apps/mobile/src/i18n/locales/en.json': JSON.stringify(ENGLISH),
    'apps/mobile/src/i18n/locales/vi.json': JSON.stringify({
      agents: {
        title: 'Tác nhân bản địa hoá',
        liveCount_one: '{{count}} phiên bản địa hoá',
        liveCount_other: '{{count}} phiên bản địa hoá',
      },
    }),
    'packages/notifications/src/locales/en.json': '{}',
    'packages/notifications/src/locales/vi.json': '{}',
    'packages/notifications/src/i18n.ts': [
      `import en from './locales/en.json';`,
      `import vi from './locales/vi.json';`,
      `const pushCatalogs = { 'en': en, 'vi': vi };`,
    ].join('\n'),
    'tools/i18n/wording-exceptions.json': WORDING_EXCEPTIONS,
  });
  symlinkSync(join(REPO, 'apps/mobile/src/lib'), join(root, 'apps/mobile/src/lib'), 'dir');
  symlinkSync(
    join(REPO, 'apps/mobile/node_modules'),
    join(root, 'apps/mobile/node_modules'),
    'dir'
  );
  const found = checkCatalogs(root).problems;
  assert.deepEqual(found, []);
});

test('rejects an unused English exact key', () => {
  const found = run({ source: "t('agents.liveCount', { count: 2 });" });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile: en\.json defines "agents\.title", which no source file uses/
  );
});

test('rejects unused English plural siblings', () => {
  const found = run({ source: "t('agents.title');" });
  const text = found.join('\n');
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(text, /mobile: en\.json defines "agents\.liveCount_one", which no source file uses/);
  assert.match(
    text,
    /mobile: en\.json defines "agents\.liveCount_other", which no source file uses/
  );
});

test('ignores a call written in a comment or a string', () => {
  const source = [
    "t('agents.title');",
    "t('agents.liveCount', { count: 2 });",
    "// t('agents.commentedOut') named the key before this screen moved",
    `const note = "t('agents.quotedInText') is not a call";`,
    'void note;',
  ].join('\n');
  assert.deepEqual(run({ source }), []);
});

test('does not count a key named only in a comment as a use', () => {
  const english = { agents: { title: 'Agents', retired: 'Retired agents' } };
  const translated = { agents: { title: 'Localized agents', retired: 'Localized retirees' } };
  const found = run({
    english,
    translated,
    source: "t('agents.title');\n// 'agents.retired' left with the old screen",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile: en\.json defines "agents\.retired", which no source file uses/
  );
});

test('still rejects a template-literal key', () => {
  const source = [
    "t('agents.title');",
    "t('agents.liveCount', { count: 2 });",
    'const page = 1;',
    't(`agents.page${page}`);',
  ].join('\n');
  const found = run({ source });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /t\(\) called with a template literal; the key check cannot see it/
  );
});

test('does not call a key unused when a source file could not be read', context => {
  // A refused read leaves that file's keys out of the scan, so the dead-key rule
  // would name every key it never saw. The unreadable file here is the one that
  // used `agents.retired`: calling it dead would ask someone to delete copy a
  // screen still renders. The read failure is reported instead, and the key the
  // readable source calls but English does not define is still named.
  if (process.getuid?.() === 0) {
    context.skip('root reads any file, so chmod 000 leaves it readable');
    return;
  }
  const file = 'apps/mobile/src/unreadable.ts';
  const found = run({
    english: { agents: { title: 'Agents', retired: 'Retired agents' } },
    translated: { agents: { title: 'Localized agents', retired: 'Localized retirees' } },
    source: "t('agents.title');\nt('agents.missing');",
    extraFiles: { [file]: "t('agents.retired');" },
    afterWrite: root => {
      const path = join(root, file);
      chmodSync(path, 0o000);
      return () => chmodSync(path, 0o644);
    },
  });
  const text = found.join('\n');
  assert.match(text, /apps\/mobile\/src\/unreadable\.ts: cannot read: /);
  assert.doesNotMatch(text, /which no source file uses/);
  assert.match(text, /mobile: source uses "agents\.missing", which en\.json does not define/);
});

test('reports a missing source tree instead of naming every key unused', () => {
  // Inside the copied checker the fixture tree IS the repository root, so every
  // declared source tree must be there. The push key below is called only from
  // `services`, so removing that tree leaves the key invisible to the scan:
  // without the completeness rule the run would name it dead, and the
  // `doesNotMatch` below would fail. The assertion therefore reads the
  // suppression and not just the missing-tree line.
  const pushEnglish = { internal: { lowBalance: 'Low balance' } };
  const pushTranslated = { internal: { lowBalance: 'Низкий баланс' } };
  const root = cliFixture({
    ...standardFiles(),
    'packages/notifications/src/locales/en.json': JSON.stringify(pushEnglish),
    'packages/notifications/src/locales/ru.json': JSON.stringify(pushTranslated),
    'services/alert.ts': "translatePush('en', 'internal.lowBalance');",
  });
  rmSync(join(root, 'services'), { recursive: true, force: true });
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^notifications: no source tree at services$/m);
  assert.doesNotMatch(result.stderr, /which no source file uses/);
});

test('reports an unparsed file by its path below the tree it was read from', () => {
  const found = run({ source: "t('agents.title'\n" });
  assert.match(
    found.join('\n'),
    /^apps\/mobile\/src\/example\.ts:2: cannot parse: /m,
    found.join('\n')
  );
});

test('accepts values that read as a brace or a key-shaped run', () => {
  // A message may quote a brace, or a `"key": 1` fragment, without the scan
  // mistaking either for the catalog's own structure.
  const english = {
    agents: {
      title: 'Agents',
      open: 'Keep the lone { in place',
      close: 'Keep the lone } in place',
      total: 'Read {{"total": 1, "title": 2}} as text',
      headline: 'Also read {{"total": 1, "title": 2}} as text',
    },
  };
  const found = run({
    extraFiles: { 'apps/mobile/src/i18n/locales/en.json': JSON.stringify(english) },
    translated: {
      agents: {
        title: 'Агенты',
        open: 'Оставьте одиночную { на месте',
        close: 'Оставьте одиночную } на месте',
        total: 'Читайте {{"total": 1, "title": 2}} как текст',
        headline: 'Читайте ещё {{"total": 1, "title": 2}} как текст',
      },
    },
    source: [
      "t('agents.title');",
      "t('agents.open');",
      "t('agents.close');",
      "t('agents.total');",
      "t('agents.headline');",
    ].join('\n'),
  });
  assert.deepEqual(found, []);
});

test('still reports a repeated key after a value closes a brace', () => {
  const found = run({
    extraFiles: {
      'apps/mobile/src/i18n/locales/en.json': [
        '{',
        '  "agents": {',
        '    "summary": "Read as text",',
        '    "title": "Agents }",',
        '    "summary": "Read as text"',
        '  }',
        '}',
      ].join('\n'),
    },
    translated: { agents: { summary: 'Читается как текст', title: 'Агенты }' } },
    source: "t('agents.title');\nt('agents.summary');",
  });
  assert.deepEqual(found, ['mobile/en: duplicate key "summary"']);
});

test('reports unbalanced English catalog braces once, without a missing-key cascade', () => {
  const found = run({
    extraFiles: {
      'apps/mobile/src/i18n/locales/en.json': [
        '{',
        '  "agents": {',
        '    "title": "Agents }",',
        '    "summary": "Read as text"',
        '}',
      ].join('\n'),
    },
    source: "t('agents.title');\nt('agents.summary');",
  });
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /cannot audit catalog: its strings and braces do not balance/);
});

test('reports a balanced catalog JSON rejects in the same one problem line', () => {
  // The braces match, so only JSON.parse can reject the file; a stack trace here
  // would hide which catalog is broken.
  const found = run({
    extraFiles: {
      'apps/mobile/src/i18n/locales/en.json': '{\n  "agents": {\n    "title" "Agents"\n  }\n}\n',
    },
  });
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /^mobile\/en: cannot audit catalog: /);
});

test('reports an unreadable locale catalog without inventing missing keys', () => {
  // The skipped locale carries no values, so it can say neither that a key is
  // missing nor that a key was left in English.
  const found = run({
    extraFiles: {
      'apps/mobile/src/i18n/locales/ru.json': [
        '{',
        '  "agents": {',
        '    "title": "Агенты }",',
        '    "liveCount_one": "{{count}} сеанс"',
        '}',
      ].join('\n'),
    },
  });
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(
    found[0],
    /^mobile\/ru: cannot audit catalog: its strings and braces do not balance/
  );
});

test('reports a missing wording-exceptions file instead of throwing', () => {
  // The exception map is read before the language registry, so a tree without
  // one reports it once and still audits everything else: the copy that reads
  // the same in every locale is reported alongside the read failure.
  const found = run({
    wordingExceptions: null,
    english: { agents: { title: 'Agents' } },
    translated: { agents: { title: 'Agents' } },
    source: "t('agents.title');",
  });
  assert.ok(found.length > 0, 'expected problems');
  assert.match(
    found.join('\n'),
    /check-catalogs: cannot read tools\/i18n\/wording-exceptions\.json: /
  );
  assert.match(found.join('\n'), /mobile: "agents\.title" equals English in every locale/);
});

test('reports a malformed wording-exceptions file instead of throwing', () => {
  const found = run({ wordingExceptions: '{' });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /check-catalogs: cannot read tools\/i18n\/wording-exceptions\.json: ./
  );
});

test('reports a valid JSON wording-exceptions value of the wrong shape', () => {
  // JSON.parse accepts every one of these, so the shape of the parsed value is
  // the only thing between the file and the callers that index it by tag.
  for (const shape of ['null', '[]', '0', '"text"']) {
    const found = run({ wordingExceptions: shape });
    assert.match(
      found.join('\n'),
      /check-catalogs: cannot read tools\/i18n\/wording-exceptions\.json: expected an object that maps each tag to a list of English strings/
    );
  }
});

test('reports a wording-exceptions entry that is not a list of strings', () => {
  // A number is not iterable, a null entry is not a set of strings, and a bare
  // string iterates character by character in the callers.
  for (const entry of [5, null, 'Agents']) {
    const found = run({ wordingExceptions: JSON.stringify({ ru: entry }) });
    assert.match(
      found.join('\n'),
      /check-catalogs: cannot read tools\/i18n\/wording-exceptions\.json: expected an object that maps each tag to a list of English strings/
    );
  }
});

test('accepts a wording-exceptions map of tag to string list', () => {
  const found = run({ wordingExceptions: JSON.stringify({ ru: [] }) });
  assert.ok(!found.join('\n').includes('cannot read'), found.join('\n'));
});

test('ignores a mounted-harness helper while a source file still reports its keys', () => {
  const source = "t('agents.missing');\n";
  const inSource = run({ source });
  assert.ok(inSource.length > 0, 'expected a problem');
  assert.match(inSource.join('\n'), /"agents\.missing"/);

  for (const helper of [
    'apps/mobile/src/components/screen.mounted.test-helpers.ts',
    'apps/mobile/src/components/screen.test.tsx',
  ]) {
    assert.deepEqual(run({ extraFiles: { [helper]: source } }), []);
  }
});

test('folds a Devanagari danda as sentence-final punctuation', () => {
  // The Hindi imperative and its error-message twin differ only by the danda,
  // so the shared-wording rule must read them as one wording.
  const found = run({
    language: 'hi',
    english: {
      common: { sentenceJoiner: '. ' },
      label: 'Choose a model',
      error: 'Choose a model.',
    },
    translated: {
      common: { sentenceJoiner: '। ' },
      label: 'मॉडल चुनें',
      error: 'मॉडल चुनें।',
    },
    source: "t('common.sentenceJoiner'); t('label'); t('error');",
  });
  assert.deepEqual(found, []);
});

test('accepts the Devanagari danda in a catalog that joins sentences with it', () => {
  const found = run({
    language: 'hi',
    english: { common: { sentenceJoiner: '. ' }, first: 'Choose a model', second: 'Try again' },
    translated: { common: { sentenceJoiner: '। ' }, first: 'मॉडल चुनें।', second: 'फिर से प्रयास करें।' },
    source: "t('common.sentenceJoiner'); t('first'); t('second');",
  });
  assert.deepEqual(found, []);
});

test('rejects a borrowed Devanagari danda in a catalog that writes another mark', () => {
  const found = run({
    language: 'kn',
    english: { common: { sentenceJoiner: '. ' }, first: 'Choose a model', second: 'Try again' },
    translated: { common: { sentenceJoiner: '.' }, first: 'ಮಾದರಿ ಆಯ್ಕೆಮಾಡಿ।', second: 'ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.' },
    source: "t('common.sentenceJoiner'); t('first'); t('second');",
  });
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /mobile\/kn/);
  assert.match(found[0], /«।»/);
  assert.match(found[0], /"first"/);
});

test('rejects a borrowed Devanagari danda in Marathi, which closes sentences with the full stop', () => {
  const found = run({
    language: 'mr',
    english: { common: { sentenceJoiner: '. ' }, first: 'Choose a model', second: 'Try again' },
    translated: {
      common: { sentenceJoiner: '.' },
      first: 'मॉडेल निवडा।',
      second: 'पुन्हा प्रयत्न करा.',
    },
    source: "t('common.sentenceJoiner'); t('first'); t('second');",
  });
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /mobile\/mr/);
  assert.match(found[0], /«।»/);
});

test('rejects a borrowed Devanagari danda in a catalog that writes no sentence mark', () => {
  // The push catalog carries no `common.sentenceJoiner`, so it states no
  // sentence mark at all and a danda there belongs to no script of its own.
  const found = run({
    language: 'hi',
    translated: { agents: HINDI_TRANSLATED.agents },
    pushEnglish: {
      generic: { title: 'Kilo', body: { chatMessage: 'You have a new message' } },
    },
    pushTranslated: {
      generic: { title: 'Kilo', body: { chatMessage: 'आपके पास एक नया संदेश है।' } },
    },
    pushSource: [
      "translatePush(locale, 'generic.title', undefined, 'Kilo');",
      "translatePush(locale, 'generic.body.chatMessage', undefined, 'You have a new message');",
    ].join('\n'),
  });
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /«।»/);
  assert.match(found[0], /no sentence mark/);
});

for (const [language, title, badge] of [
  ['tr', 'Çalışıyor', 'ÇALIŞIYOR'],
  ['az', 'İşləyir', 'İŞLƏYİR'],
  ['el', 'Σε εξέλιξη', 'ΣΕ ΕΞΕΛΙΞΗ'],
  ['de', 'Straße', 'STRASSE'],
]) {
  test(`accepts locale-aware case variants in ${language}`, () => {
    const found = run({
      language,
      english: { title: 'Running', badge: 'RUNNING' },
      translated: { title, badge },
      source: "t('title'); t('badge');",
    });
    assert.deepEqual(found, []);
  });
}

test('still rejects different wording after locale-aware case folding', () => {
  const found = run({
    language: 'tr',
    english: { title: 'Running', badge: 'RUNNING' },
    translated: { title: 'Çalışıyor', badge: 'DURDU' },
    source: "t('title'); t('badge');",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /English "running" is translated 2 ways/);
});

test('rejects the English live-session empty state in a translated catalog', () => {
  const english = { home: { noLiveSessions: 'Nothing running right now' } };
  const found = run({
    english,
    translated: english,
    source: "t('home.noLiveSessions');",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: "home\.noLiveSessions" must be translated/);
});

test('accepts a translated live-session empty state', () => {
  const english = { home: { noLiveSessions: 'Nothing running right now' } };
  const found = run({
    english,
    translated: { home: { noLiveSessions: 'Сейчас ничего не запущено' } },
    source: "t('home.noLiveSessions');",
  });
  assert.deepEqual(found, []);
});

test('rejects an empty translated value', () => {
  const found = run({
    translated: { agents: { ...TRANSLATED.agents, title: '' } },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: "agents\.title" is empty/);
});

test('accepts a bare-space sentence joiner in the markless Thai catalog', () => {
  // Thai closes no sentence with a mark, so its joiner is the space it
  // separates sentences with; the empty-value rule must not read it as
  // untranslated.
  const found = run({
    language: 'th',
    english: { common: { sentenceJoiner: '. ' }, agents: ENGLISH.agents },
    translated: { common: { sentenceJoiner: ' ' }, agents: THAI_TRANSLATED.agents },
    source: `${SOURCE}\nt('common.sentenceJoiner');`,
  });
  assert.deepEqual(found, []);
});

test('rejects a whitespace-only sentence joiner in a catalog that closes sentences', () => {
  // A catalog whose copy carries sentence marks must name one in its joiner;
  // a blanked joiner would silently join sentences with nothing.
  const found = run({
    english: { common: { sentenceJoiner: '. ' }, agents: ENGLISH.agents },
    translated: { common: { sentenceJoiner: ' ' }, agents: TRANSLATED.agents },
    source: `${SOURCE}\nt('common.sentenceJoiner');`,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: "common\.sentenceJoiner" is empty/);
});

test('rejects an empty sentence joiner in the markless Thai catalog', () => {
  const found = run({
    language: 'th',
    english: { common: { sentenceJoiner: '. ' }, agents: ENGLISH.agents },
    translated: { common: { sentenceJoiner: '' }, agents: TRANSLATED.agents },
    source: `${SOURCE}\nt('common.sentenceJoiner');`,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/th: "common\.sentenceJoiner" is empty/);
});

test('rejects a locale value that is a serialized JSON object', () => {
  // A translation store once shipped an action label wrapped in a JSON
  // object; the reader would see the braces and quotes instead of the words.
  const found = run({
    translated: { agents: { ...TRANSLATED.agents, title: '{"value": "Localized agents"}' } },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: "agents\.title" is serialized JSON/);
});

test('rejects scalar JSON copied into a catalog', () => {
  const found = run({
    english: { agents: { ...ENGLISH.agents } },
    translated: {
      agents: {
        ...TRANSLATED.agents,
        title: '9',
        liveCount_one: 'true',
        liveCount_other: 'null',
      },
    },
    source: SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: "agents\.title" is serialized JSON/);
  assert.match(found.join('\n'), /mobile\/ru: "agents\.liveCount_one" is serialized JSON/);
  assert.match(found.join('\n'), /mobile\/ru: "agents\.liveCount_other" is serialized JSON/);
});

test('accepts prose copy that only starts with a bracket', () => {
  // A bracket that opens prose copy does not make it a serialized object:
  // `[{{provider}}] агенты` never parses as JSON. English keeps the same
  // placeholder, so the two catalogs agree on it.
  const found = run({
    english: { agents: { title: '[{{provider}}] agents' } },
    translated: { agents: { title: '[{{provider}}] агенты' } },
    source: "t('agents.title');",
  });
  assert.deepEqual(found, []);
});

test('rejects an English value that is a serialized JSON object', () => {
  const found = run({
    english: { agents: { ...ENGLISH.agents, title: '{"value": "Agents"}' } },
    source: "t('agents.title');\nt('agents.liveCount', { count: 2 });",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/en: "agents\.title" is serialized JSON/);
});

test('rejects a trailing space that English does not carry', () => {
  const found = run({
    translated: { agents: { ...TRANSLATED.agents, title: 'Localized agents ' } },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: "agents\.title" leading or trailing space differs/);
});

test('accepts a locale-owned separator in the login legal sentence', () => {
  // A catalog that does not separate words with spaces abuts the prefix, the
  // Terms link and the conjunction, so its values carry no edge whitespace
  // where English has one.
  const english = {
    login: {
      termsPrefix: 'By continuing you agree to our ',
      terms: 'Terms',
      termsConnector: ' and ',
    },
  };
  const found = run({
    language: 'zh-Hans',
    english,
    translated: {
      login: { termsPrefix: '继续即表示你同意我们的', terms: '条款', termsConnector: '和' },
    },
    source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
  });
  assert.deepEqual(found, []);
});

test('still rejects separator whitespace elsewhere in the same catalog', () => {
  const english = { login: { termsPrefix: 'By continuing you agree to our ', terms: 'Terms' } };
  const found = run({
    language: 'zh-Hans',
    english,
    translated: { login: { termsPrefix: '继续即表示你同意我们的', terms: '条款 ' } },
    source: "t('login.termsPrefix'); t('login.terms');",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/zh-Hans: "login\.terms" leading or trailing space differs/
  );
});

for (const [name, termsPrefix, termsConnector] of [
  ['a dropped separator in a spaced catalog', 'Unsere', ' und '],
  ['a padded prefix beside a bare conjunction', 'Unsere ', 'und'],
]) {
  test(`rejects ${name}`, () => {
    const english = {
      login: {
        termsPrefix: 'By continuing you agree to our ',
        terms: 'Terms',
        termsConnector: ' and ',
      },
    };
    const found = run({
      language: 'de',
      english,
      translated: { login: { termsPrefix, terms: 'Bedingungen', termsConnector } },
      source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
    });
    assert.ok(found.length > 0, 'expected a problem');
    assert.match(
      found.join('\n'),
      /mobile\/de: "login\.termsPrefix" and "login\.termsConnector" disagree about the space before the Terms link/
    );
  });
}

test('accepts a spaced catalog that pads both separator keys', () => {
  const english = {
    login: {
      termsPrefix: 'By continuing you agree to our ',
      terms: 'Terms',
      termsConnector: ' and ',
    },
  };
  const found = run({
    language: 'de',
    english,
    translated: {
      login: {
        termsPrefix: 'Wenn du fortfährst, akzeptierst du unsere ',
        terms: 'Bedingungen',
        termsConnector: ' und ',
      },
    },
    source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
  });
  assert.deepEqual(found, []);
});

test('accepts a catalog whose conjunction is a prefix letter joined to the next word', () => {
  // Arabic writes the waw as a prefix of the noun it governs, so the catalog
  // pads the space before the conjunction and none after it. The junction
  // before the conjunction is the separator the two keys have to agree on.
  const english = {
    login: {
      termsPrefix: 'By continuing you agree to our ',
      terms: 'Terms',
      termsConnector: ' and ',
    },
  };
  const found = run({
    language: 'ar',
    english,
    translated: {
      login: {
        termsPrefix: 'بالمتابعة، توافق على ',
        terms: 'الشروط',
        termsConnector: ' و',
      },
    },
    source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
  });
  assert.deepEqual(found, []);
});

test('rejects a detached conjunction in a catalog that writes one prefix letter', () => {
  // The prefix letter joins the noun it governs, so a space after it splits the
  // conjunction from that noun — the defect this rule exists to catch.
  const english = {
    login: {
      termsPrefix: 'By continuing you agree to our ',
      terms: 'Terms',
      termsConnector: ' and ',
    },
  };
  const found = run({
    language: 'ar',
    english,
    translated: {
      login: {
        termsPrefix: 'بالمتابعة، توافق على ',
        terms: 'الشروط',
        termsConnector: ' و ',
      },
    },
    source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ar: "login\.termsConnector" must end without a space, because this catalog writes the conjunction as a prefix of the next word/
  );
});

test('rejects a separately written conjunction that lost its trailing space', () => {
  // A catalog that writes the conjunction as a word of its own pads both sides;
  // keeping only the leading space runs it into the noun after the link.
  const english = {
    login: {
      termsPrefix: 'By continuing you agree to our ',
      terms: 'Terms',
      termsConnector: ' and ',
    },
  };
  const found = run({
    language: 'de',
    english,
    translated: {
      login: {
        termsPrefix: 'Wenn du fortfährst, akzeptierst du unsere ',
        terms: 'Bedingungen',
        termsConnector: ' und',
      },
    },
    source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/de: "login\.termsConnector" must end with a space, because this catalog writes the conjunction as a separate word/
  );
});

test('accepts an abutting catalog whose conjunction carries no spaces', () => {
  // Japanese abuts its words, so neither the prefix nor the conjunction carries
  // an edge space. The connector's edge rule follows the prefix: a catalog that
  // pads nothing demands nothing.
  const english = {
    login: {
      termsPrefix: 'By continuing you agree to our ',
      terms: 'Terms',
      termsConnector: ' and ',
    },
  };
  const found = run({
    language: 'ja',
    english,
    translated: {
      login: {
        termsPrefix: '続行すると、',
        terms: '利用規約',
        termsConnector: 'および',
      },
    },
    source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
  });
  assert.deepEqual(found, []);
});

test('rejects a conjunction that starts without the space its prefix carries', () => {
  const english = {
    login: {
      termsPrefix: 'By continuing you agree to our ',
      terms: 'Terms',
      termsConnector: ' and ',
    },
  };
  const found = run({
    language: 'ar',
    english,
    translated: {
      login: {
        termsPrefix: 'بالمتابعة، توافق على ',
        terms: 'الشروط',
        termsConnector: 'و',
      },
    },
    source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ar: "login\.termsPrefix" and "login\.termsConnector" disagree about the space before the Terms link/
  );
});

test('rejects a translated $TOKEN expansion token', () => {
  const found = run({
    english: { agents: { template: 'Explain $ARGUMENTS' } },
    translated: { agents: { template: 'Explique $ARGUMENTOS' } },
    source: "t('agents.template');",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "agents\.template" \$TOKEN expansion tokens differ from English \(\$ARGUMENTS\)/
  );
});

test('rejects changed placeholders in an English plural sibling', () => {
  const found = run({
    translated: { agents: { ...TRANSLATED.agents, liveCount_one: '{{total}} localized session' } },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "agents\.liveCount_one" placeholders differ from English \(count\)/
  );
});

test('rejects unknown placeholders in a locale-specific plural category', () => {
  const found = run({
    translated: {
      agents: { ...TRANSLATED.agents, liveCount_few: '{{total}} localized sessions (few)' },
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "agents\.liveCount_few" placeholders differ from English \(count\)/
  );
});

const SINGULAR_COUNTED = {
  agents: {
    title: 'Agents',
    liveCount_one: '1 live session',
    liveCount_other: '{{count}} live sessions',
  },
};

test('accepts a category that interpolates the count its English family uses', () => {
  const found = run({
    english: SINGULAR_COUNTED,
    translated: {
      agents: {
        title: 'Localized agents',
        liveCount_one: '{{count}} localized session',
        liveCount_few: '{{count}} localized sessions (few)',
        liveCount_many: '{{count}} localized sessions (many)',
        liveCount_other: '{{count}} localized sessions',
      },
    },
  });
  assert.deepEqual(found, []);
});

test('still rejects a token no value of the family uses', () => {
  const found = run({
    english: SINGULAR_COUNTED,
    translated: {
      agents: {
        title: 'Localized agents',
        liveCount_one: '{{count}} localized session out of {{total}}',
        liveCount_few: '{{count}} localized sessions (few)',
        liveCount_many: '{{count}} localized sessions (many)',
        liveCount_other: '{{count}} localized sessions',
      },
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "agents\.liveCount_one" placeholders differ from English \(none\)/
  );
});

test('still rejects a category that drops a placeholder English requires', () => {
  const found = run({
    english: {
      agents: {
        title: 'Agents',
        liveCount_one: '{{total}} live session',
        liveCount_other: '{{count}} of {{total}} live sessions',
      },
    },
    translated: {
      agents: {
        title: 'Localized agents',
        liveCount_one: '{{count}} localized session',
        liveCount_few: '{{count}} localized sessions (few)',
        liveCount_many: '{{count}} localized sessions (many)',
        liveCount_other: '{{count}} localized sessions',
      },
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "agents\.liveCount_other" placeholders differ from English \(count,total\)/
  );
});

// A placeholder token may hold a comma: `{{a,b}}` is one token. The family
// exemption has to read the tokens the text writes, or a category that adds a
// family token whose name holds a comma looks like one that adds two tokens no
// value of the family uses.
const COMMA_TOKEN_ENGLISH = {
  agents: {
    title: 'Agents',
    liveCount_one: '{{count}} live session',
    liveCount_other: '{{count}} items {{a,b}}',
  },
};

test('accepts a family token that spells a comma inside one placeholder', () => {
  const found = run({
    english: COMMA_TOKEN_ENGLISH,
    translated: {
      agents: {
        title: 'Localized agents',
        liveCount_one: '{{count}} localized session {{a,b}}',
        liveCount_few: '{{count}} localized sessions (few) {{a,b}}',
        liveCount_many: '{{count}} localized sessions (many) {{a,b}}',
        liveCount_other: '{{count}} localized items {{a,b}}',
      },
    },
  });
  assert.ok(!found.join('\n').includes('placeholders differ from English'), found.join('\n'));
});

test('still rejects a translation that repeats a placeholder token', () => {
  const found = run({
    translated: {
      agents: { ...TRANSLATED.agents, liveCount_one: '{{count}} {{count}} localized session' },
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "agents\.liveCount_one" placeholders differ from English \(count\)/
  );
});

/**
 * A counted form may say its number in a word instead of the placeholder, but
 * only where the allowlist names that key, category and locale: Arabic names
 * one day and two days with their own word forms. Every other form of the same
 * family still has to keep its count, so a deleted number stays visible.
 */
const WORDED_ENGLISH = {
  securityAgent: {
    dashboard: {
      title: 'Dashboard',
      daysOverdue_one: '{{displayCount}} day overdue',
      daysOverdue_other: '{{displayCount}} days overdue',
    },
  },
};
const WORDED_SOURCE =
  "t('securityAgent.dashboard.title');\nt('securityAgent.dashboard.daysOverdue', { count: 2 });";
const WORDED_TRANSLATED = {
  securityAgent: {
    dashboard: {
      title: 'لوحة المعلومات',
      daysOverdue_zero: 'لا تأخير',
      daysOverdue_one: 'متأخرة يومًا واحدًا',
      daysOverdue_two: 'متأخرة يومين',
      daysOverdue_few: 'متأخرة {{displayCount}} أيام',
      daysOverdue_many: 'متأخرة {{displayCount}} يومًا',
      daysOverdue_other: 'متأخرة {{displayCount}} يوم',
    },
  },
};

test('accepts the reviewed plural forms that say their count in a word', () => {
  const found = run({
    english: WORDED_ENGLISH,
    translated: WORDED_TRANSLATED,
    source: WORDED_SOURCE,
    language: 'ar',
  });
  assert.deepEqual(found, []);
});

test('rejects a dropped count in an unreviewed locale-only plural form', () => {
  const found = run({
    english: WORDED_ENGLISH,
    translated: {
      securityAgent: {
        dashboard: {
          ...WORDED_TRANSLATED.securityAgent.dashboard,
          daysOverdue_few: 'متأخرة أيام',
        },
      },
    },
    source: WORDED_SOURCE,
    language: 'ar',
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ar: "securityAgent\.dashboard\.daysOverdue_few" drops \{\{displayCount\}\} without a reviewed worded form/
  );
});

test('rejects a dropped count in a plural form the allowlist does not name', () => {
  const found = run({
    english: WORDED_ENGLISH,
    translated: {
      securityAgent: {
        dashboard: {
          ...WORDED_TRANSLATED.securityAgent.dashboard,
          daysOverdue_other: 'متأخرة يوم',
        },
      },
    },
    source: WORDED_SOURCE,
    language: 'ar',
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ar: "securityAgent\.dashboard\.daysOverdue_other" placeholders differ from English \(displayCount\)/
  );
});

test('rejects a plural sibling that drops a value other than its count', () => {
  const found = run({
    english: {
      agents: {
        title: 'Agents',
        window: '{{displayCount}} days from {{start}}',
        window_one: '{{displayCount}} day from {{start}}',
        window_other: '{{displayCount}} days from {{start}}',
      },
    },
    translated: {
      agents: {
        title: 'Localized agents',
        window: '{{displayCount}} дней с {{start}}',
        window_one: 'один день ({{displayCount}})',
        window_few: '{{displayCount}} дня с {{start}}',
        window_many: '{{displayCount}} дней с {{start}}',
        window_other: '{{displayCount}} дней с {{start}}',
      },
    },
    source: "t('agents.title');\nt('agents.window', { count: 2 });",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "agents\.window_one" placeholders differ from English \(displayCount,start\)/
  );
});

/**
 * The Security Agent deadline family counts with i18next's own `count`, which
 * selects the plural category and is also read into the message. Arabic still
 * names one and two with their own word forms, so the reviewed forms drop that
 * numeral; an unreviewed form keeps it, and a reviewed form still may not drop a
 * placeholder that is not the count.
 */
const WORDED_COUNT_ENGLISH = {
  securityAgent: {
    deadline: {
      dueInDays_one: 'Due in {{count}} day',
      dueInDays_other: 'Due in {{count}} days',
    },
  },
};
const WORDED_COUNT_SOURCE = "t('securityAgent.deadline.dueInDays', { count: 2 });";
const WORDED_COUNT_TRANSLATED = {
  securityAgent: {
    deadline: {
      dueInDays_zero: 'الأيام المتبقية للموعد: {{count}}',
      dueInDays_one: 'مستحق بعد يوم واحد',
      dueInDays_two: 'الموعد بعد يومين',
      dueInDays_few: 'الموعد بعد {{count}} أيام',
      dueInDays_many: 'الموعد بعد {{count}} يومًا',
      dueInDays_other: 'تنتهي المهلة بعد {{count}} يوم',
    },
  },
};

test('accepts a reviewed worded form of a family counted with i18next’s count', () => {
  const found = run({
    english: WORDED_COUNT_ENGLISH,
    translated: WORDED_COUNT_TRANSLATED,
    source: WORDED_COUNT_SOURCE,
    language: 'ar',
  });
  assert.deepEqual(found, []);
});

test('rejects a dropped count in an unreviewed form of that family', () => {
  const found = run({
    english: WORDED_COUNT_ENGLISH,
    translated: {
      securityAgent: {
        deadline: {
          ...WORDED_COUNT_TRANSLATED.securityAgent.deadline,
          dueInDays_few: 'الموعد بعد أيام',
        },
      },
    },
    source: WORDED_COUNT_SOURCE,
    language: 'ar',
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ar: "securityAgent\.deadline\.dueInDays_few" drops \{\{count\}\} without a reviewed worded form/
  );
});

test('rejects the same worded form in a locale the allowlist does not name', () => {
  const found = run({
    english: WORDED_COUNT_ENGLISH,
    translated: {
      securityAgent: {
        deadline: {
          dueInDays_one: 'לתיקון תוך יום',
          dueInDays_two: 'המועד האחרון בעוד יומיים',
          dueInDays_many: 'נותרו {{count}} ימים למועד האחרון',
          dueInDays_other: 'נותרו {{count}} ימים למועד האחרון',
        },
      },
    },
    source: WORDED_COUNT_SOURCE,
    language: 'he',
  });
  assert.ok(found.length > 0, 'expected a problem');
  // The dual has no English sibling, so only the reviewed-form allowance could
  // accept it: a Hebrew entry must not ride on the Arabic one.
  assert.match(
    found.join('\n'),
    /mobile\/he: "securityAgent\.deadline\.dueInDays_two" drops \{\{count\}\} without a reviewed worded form/
  );
});

const COUNTED = {
  counts: {
    items: '{{count}} items',
    itemsShort: '{{count}}i',
  },
};
const COUNTED_SOURCE = "t('counts.items', { count: 2 });\nt('counts.itemsShort', { count: 2 });";

test('accepts a locale-declared family for a flat counted English key', () => {
  const found = run({
    english: COUNTED,
    translated: {
      counts: {
        items: '{{count}} lokal',
        items_one: '{{count}} lokal',
        items_few: '{{count}} lokala',
        items_many: '{{count}} lokala',
        items_other: '{{count}} lokala',
        itemsShort: '{{count}}l',
      },
    },
    source: COUNTED_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('accepts a flat counted key kept untranslated to a family in another locale', () => {
  const found = run({
    english: COUNTED,
    translated: { counts: { items: '{{count}} lokala', itemsShort: '{{count}}l' } },
    source: COUNTED_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('leaves an incomplete English family unowed by a locale', () => {
  // English declares only the `_one` category of the family, so it is not a
  // family every locale owes. Neither value interpolates {{count}}: a locale
  // that keeps only the flat base key owes no categories for it.
  const found = run({
    english: { counts: { items: 'items', items_one: 'one item' } },
    translated: { counts: { items: 'lokal' } },
    source: "t('counts.items', { count: 2 });",
  });
  assert.deepEqual(found, []);
});

test('names the categories a locale must complete for each family', () => {
  // A family the locale declares owes every category its tag selects, whether
  // it declares the family through a member or through the flat base key of an
  // owed English family; a locale that carries neither owes nothing for it. A
  // counted flat English key becomes the locale's problem once the locale
  // declares the family.
  const english = flattenCatalog({
    agents: {
      open_one: '{{displayCount}} open session',
      open_other: '{{displayCount}} open sessions',
    },
  });
  const counted = flattenCatalog({ counts: { items: '{{count}} items' } });
  const flatKey = flattenCatalog({ agents: { open: 'x' } });
  const oneMember = flattenCatalog({ agents: { open_one: 'x' } });
  const declared = flattenCatalog({
    counts: { items: 'x', items_one: 'x', items_other: 'x' },
  });

  assert.deepEqual(
    [...missingPluralCategories(english, flatKey, 'ru')],
    [['agents.open', ['one', 'few', 'many', 'other']]]
  );
  assert.deepEqual(
    [...missingPluralCategories(english, oneMember, 'ru')],
    [['agents.open', ['few', 'many', 'other']]]
  );
  assert.deepEqual([...missingPluralCategories(english, flattenCatalog({}), 'ru')], []);
  assert.deepEqual(
    [...missingPluralCategories(counted, declared, 'ru')],
    [['counts.items', ['few', 'many']]]
  );
});

test('rejects an incomplete locale-declared family for a counted key', () => {
  const found = run({
    english: COUNTED,
    translated: {
      counts: {
        items: '{{count}} lokal',
        items_one: '{{count}} lokal',
        itemsShort: '{{count}}l',
      },
    },
    source: COUNTED_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: plural family "counts\.items" lacks the other category of ru/
  );
});

test('rejects a wrong placeholder in a locale-declared counted family', () => {
  const found = run({
    english: COUNTED,
    translated: {
      counts: {
        items: '{{count}} lokal',
        items_one: '{{total}} lokal',
        items_other: '{{total}} lokala',
        itemsShort: '{{count}}l',
      },
    },
    source: COUNTED_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "counts\.items_one" placeholders differ from English \(count\)/
  );
});

test('still rejects an unrelated extra key beside a counted family', () => {
  const found = run({
    english: COUNTED,
    translated: {
      counts: {
        items: '{{count}} lokal',
        items_one: '{{count}} lokal',
        items_other: '{{count}} lokala',
        itemsShort: '{{count}}l',
        stray: 'extra',
      },
    },
    source: COUNTED_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: extra key "counts\.stray" is not in en\.json/);
});

/**
 * Two dashboard lines render the same bucket in their own wording: the
 * repository row and the deadline breakdown. English spells the bucket once, so
 * both keys hold one string; a catalog may still word them apart, and may still
 * inflect one family's own categories.
 */
const BUCKET_PHRASES = {
  securityAgent: {
    dashboard: {
      title: 'Dashboard',
      repoSummaryCritical: '{{displayCount}} critical',
      repoSummaryCritical_one: '{{displayCount}} critical',
      repoSummaryCritical_other: '{{displayCount}} critical',
      repoSummaryOpen: '{{displayCount}} open',
      repoSummaryOpen_one: '{{displayCount}} open',
      repoSummaryOpen_other: '{{displayCount}} open',
    },
    dashboardMetrics: {
      breakdownCritical: '{{displayCount}} critical',
      breakdownCritical_one: '{{displayCount}} critical',
      breakdownCritical_other: '{{displayCount}} critical',
      breakdownHigh: '{{displayCount}} high',
      breakdownHigh_one: '{{displayCount}} high',
      breakdownHigh_other: '{{displayCount}} high',
    },
  },
};
const BUCKET_SOURCE = [
  "t('securityAgent.dashboard.title');",
  "t('securityAgent.dashboard.repoSummaryCritical', { count: 1, displayCount: '1' });",
  "t('securityAgent.dashboard.repoSummaryOpen', { count: 1, displayCount: '1' });",
  "t('securityAgent.dashboardMetrics.breakdownCritical', { count: 1, displayCount: '1' });",
  "t('securityAgent.dashboardMetrics.breakdownHigh', { count: 1, displayCount: '1' });",
].join('\n');

test('accepts the two lines wording one bucket apart', () => {
  const found = run({
    english: BUCKET_PHRASES,
    translated: {
      securityAgent: {
        dashboard: {
          title: 'Painel',
          repoSummaryCritical: '{{displayCount}} críticas',
          repoSummaryCritical_one: '{{displayCount}} crítica',
          repoSummaryCritical_other: '{{displayCount}} críticas',
          repoSummaryOpen: '{{displayCount}} abertas',
          repoSummaryOpen_one: '{{displayCount}} aberta',
          repoSummaryOpen_other: '{{displayCount}} abertas',
        },
        dashboardMetrics: {
          breakdownCritical: '{{displayCount}} críticos',
          breakdownCritical_one: '{{displayCount}} crítico',
          breakdownCritical_other: '{{displayCount}} críticos',
          breakdownHigh: '{{displayCount}} de nível alto',
          breakdownHigh_one: '{{displayCount}} de nível alto',
          breakdownHigh_other: '{{displayCount}} de nível alto',
        },
      },
    },
    source: BUCKET_SOURCE,
    // Norwegian Bokmål asks for one and other, so the fixture states only the
    // categories its own plural rules require.
    language: 'nb',
  });
  assert.deepEqual(found, []);
});

test('still rejects two unrelated families worded apart', () => {
  const english = {
    agents: {
      title: 'Agents',
      liveCount_one: '{{count}} live session',
      liveCount_other: '{{count}} live sessions',
      heldCount_one: '{{count}} live session',
      heldCount_other: '{{count}} live sessions',
    },
  };
  const found = run({
    english,
    translated: {
      agents: {
        title: 'Localized agents',
        liveCount_one: '{{count}} localized session',
        liveCount_few: '{{count}} localized sessions (few)',
        liveCount_many: '{{count}} localized sessions (many)',
        liveCount_other: '{{count}} localized sessions',
        heldCount_one: '{{count}} held session',
        heldCount_few: '{{count}} held sessions (few)',
        heldCount_many: '{{count}} held sessions (many)',
        heldCount_other: '{{count}} held sessions',
      },
    },
    source: `${SOURCE}\nt('agents.heldCount', { count: 2 });`,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /is translated 2 ways/);
});

const AGENT_EDITOR = {
  agents: { title: 'Agents' },
  profiles: {
    agents: {
      visibilityPrimary: 'Primary — in the picker',
      visibilitySubagent: 'Subagent — callable from others',
      visibilityAll: 'All — both',
      topP: 'Top P',
    },
  },
};
const AGENT_EDITOR_TRANSLATED = {
  agents: { title: 'Агенты' },
  profiles: {
    agents: {
      visibilityPrimary: 'Основной — в списке',
      visibilitySubagent: 'Субагент — только извне',
      visibilityAll: 'Все — оба',
      topP: 'Top P',
    },
  },
};
const AGENT_EDITOR_SOURCE = [
  "t('agents.title');",
  "t('profiles.agents.visibilityPrimary');",
  "t('profiles.agents.visibilitySubagent');",
  "t('profiles.agents.visibilityAll');",
  "t('profiles.agents.topP');",
].join('\n');

test('accepts one spaced em dash in every agent-editor visibility option', () => {
  const found = run({
    english: AGENT_EDITOR,
    translated: AGENT_EDITOR_TRANSLATED,
    source: AGENT_EDITOR_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('rejects a visibility option whose label and description use a hyphen', () => {
  const found = run({
    english: AGENT_EDITOR,
    translated: {
      ...AGENT_EDITOR_TRANSLATED,
      profiles: {
        agents: { ...AGENT_EDITOR_TRANSLATED.profiles.agents, visibilityAll: 'Все - оба' },
      },
    },
    source: AGENT_EDITOR_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "profiles\.agents\.visibilityAll" must join its label and description with " — "/
  );
});

test('rejects a catalog that translates the sampling parameter label', () => {
  const found = run({
    english: AGENT_EDITOR,
    translated: {
      ...AGENT_EDITOR_TRANSLATED,
      profiles: {
        agents: { ...AGENT_EDITOR_TRANSLATED.profiles.agents, topP: 'Верхний P' },
      },
    },
    source: AGENT_EDITOR_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ru: "profiles\.agents\.topP" must read "Top P" in every catalog/
  );
});

test('rejects a serialized JSON value in a verbatim English label', () => {
  // The verbatim rule reads a locale against the English reference, so it cannot
  // catch JSON in the English catalog; only the storage-slip rule can.
  const topP = '{"value":"Top P"}';
  const found = run({
    english: {
      ...AGENT_EDITOR,
      profiles: { agents: { ...AGENT_EDITOR.profiles.agents, topP } },
    },
    translated: {
      ...AGENT_EDITOR_TRANSLATED,
      profiles: { agents: { ...AGENT_EDITOR_TRANSLATED.profiles.agents, topP } },
    },
    source: AGENT_EDITOR_SOURCE,
  });
  assert.match(
    found.join('\n'),
    /mobile\/en: "profiles\.agents\.topP" is serialized JSON; write the label text/
  );
});

const PULL_REQUEST_TERM = {
  agents: { title: 'Agents' },
  manualReview: { startNotFound: 'Could not read that PR from GitHub.' },
};
const PULL_REQUEST_TERM_SOURCE = "t('agents.title');\nt('manualReview.startNotFound');";

test('accepts the pull-request term capitalized in a catalog', () => {
  const found = run({
    english: PULL_REQUEST_TERM,
    translated: {
      agents: { title: 'Агенты' },
      manualReview: { startNotFound: 'Не удалось прочитать этот PR из GitHub.' },
    },
    source: PULL_REQUEST_TERM_SOURCE,
  });
  assert.deepEqual(found, []);
});

for (const [miscased, name] of [
  ['pR', 'the acronym with a lower-case first letter'],
  ['pull-Request', 'the hyphenated term with a lower-case first letter'],
]) {
  test(`rejects ${name}`, () => {
    const found = run({
      english: PULL_REQUEST_TERM,
      translated: {
        agents: { title: 'Агенты' },
        manualReview: { startNotFound: `Не удалось прочитать этот ${miscased} из GitHub.` },
      },
      source: PULL_REQUEST_TERM_SOURCE,
    });
    assert.ok(found.length > 0, 'expected a problem');
    assert.match(
      found.join('\n'),
      new RegExp(
        `mobile/ru: "manualReview\\.startNotFound" writes the pull-request term "${miscased}"; write "PR" or "Pull-Request"`
      )
    );
  });
}

const ARMENIAN_TERMINATORS = {
  work: {
    empty: 'Nothing to do.',
    waiting: 'Waiting...',
    retry: 'Try again',
    host: 'Open kilo.ai',
    note: 'Contact support',
  },
};
const ARMENIAN_TERMINATORS_SOURCE =
  "t('work.empty');\nt('work.waiting');\nt('work.retry');\nt('work.host');\nt('work.note');";

test('accepts Armenian copy that closes its sentences with «։»', () => {
  const found = run({
    language: 'hy',
    english: ARMENIAN_TERMINATORS,
    translated: {
      work: {
        empty: 'Անելիք չկա։',
        waiting: 'Սպասում ենք...',
        retry: 'Կրկին փորձել',
        host: 'Բացել kilo.ai',
        note: 'Էլ. հասցե',
      },
    },
    source: ARMENIAN_TERMINATORS_SOURCE,
  });
  assert.deepEqual(found, []);
});

for (const [name, value, mark] of [
  ['a terminal period', 'Անելիք չկա.', '.'],
  ['a period before the next sentence', 'Չհաջողվեց. Կրկին փորձեք', '.'],
  ['a terminal colon', 'Չհաջողվեց պատասխանել:', ':'],
]) {
  test(`rejects Armenian copy with ${name}`, () => {
    const found = run({
      language: 'hy',
      english: ARMENIAN_TERMINATORS,
      translated: {
        work: {
          empty: value,
          waiting: 'Սպասում ենք...',
          retry: 'Կրկին փորձել',
          host: 'Բացել kilo.ai',
          note: 'Էլ. հասցե',
        },
      },
      source: ARMENIAN_TERMINATORS_SOURCE,
    });
    assert.ok(found.length > 0, 'expected a problem');
    assert.match(
      found.join('\n'),
      new RegExp(
        `mobile/hy: "work\\.empty" ends a sentence with the ASCII "${mark}"; Armenian writes «։»`
      )
    );
  });
}

test('rejects Armenian copy with a period that joins two sentences', () => {
  const found = run({
    language: 'hy',
    english: ARMENIAN_TERMINATORS,
    translated: {
      work: {
        empty: 'Մուտքագրեք հասցեն. այն պահպանվում է',
        waiting: 'Սպասում ենք...',
        retry: 'Կրկին փորձել',
        host: 'Բացել kilo.ai',
        note: 'Էլ. հասցե',
      },
    },
    source: ARMENIAN_TERMINATORS_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/hy: "work\.empty" joins two sentences with the ASCII "\."; Armenian writes «։» and «՝»/
  );
});

test('leaves another locale’s ASCII sentence terminator alone', () => {
  const found = run({
    language: 'ru',
    english: ARMENIAN_TERMINATORS,
    translated: {
      work: {
        empty: 'Нечего делать.',
        waiting: 'Ждём...',
        retry: 'Повторить',
        host: 'Открыть kilo.ai',
        note: 'Эл. адрес',
      },
    },
    source: ARMENIAN_TERMINATORS_SOURCE,
  });
  assert.deepEqual(found, []);
});

const URDU_TERMINATORS_ENGLISH = {
  common: { sentenceJoiner: '. ', listJoiner: ', ' },
  work: {
    empty: 'Nothing to do.',
    waiting: 'Waiting...',
    retry: 'Try again',
    host: 'Open kilo.ai',
    note: 'Contact support',
    file: 'Read this file',
  },
};
const URDU_TERMINATORS_SOURCE =
  "t('common.sentenceJoiner');\nt('common.listJoiner');\nt('work.empty');\nt('work.waiting');\nt('work.retry');\nt('work.host');\nt('work.note');\nt('work.file');";
const URDU_TERMINATOR_WORK = {
  empty: 'کوئی کام نہیں۔',
  waiting: 'انتظار...',
  retry: 'دوبارہ کوشش کریں',
  host: 'kilo.ai کھولیں۔',
  note: 'رپورٹنگ Sentry.',
  file: 'فائل.png کھولیں۔',
};

/** The Urdu catalog fixture: it declares the Urdu full stop as its joiner. */
function urduTerminators(work = URDU_TERMINATOR_WORK) {
  return { common: { sentenceJoiner: '۔ ', listJoiner: '، ' }, work };
}

test('accepts Urdu copy that closes its sentences with «۔»', () => {
  const found = run({
    language: 'ur',
    english: URDU_TERMINATORS_ENGLISH,
    translated: urduTerminators(),
    source: URDU_TERMINATORS_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('rejects Urdu copy with a terminal ASCII period', () => {
  const found = run({
    language: 'ur',
    english: URDU_TERMINATORS_ENGLISH,
    translated: urduTerminators({ ...URDU_TERMINATOR_WORK, empty: 'کوئی کام نہیں.' }),
    source: URDU_TERMINATORS_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ur: "work\.empty" ends a sentence with the ASCII "\."; Urdu writes «۔»/
  );
});

test('rejects Urdu copy with a period that joins two sentences', () => {
  const found = run({
    language: 'ur',
    english: URDU_TERMINATORS_ENGLISH,
    translated: urduTerminators({
      ...URDU_TERMINATOR_WORK,
      empty: 'پہلے یہ کریں. پھر دوبارہ کوشش کریں',
    }),
    source: URDU_TERMINATORS_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /mobile\/ur: "work\.empty" joins two sentences with the ASCII "\."; Urdu writes «۔»/
  );
});

const URDU_JOIN_ENGLISH = {
  common: { sentenceJoiner: '. ', listJoiner: ', ' },
  goal: {
    sectionAccessibility: '{{status}}. Goal: {{text}}',
    note: 'Kilo (kilo.ai).',
    closing: 'Reporting',
  },
};
const URDU_JOIN_SOURCE =
  "t('common.sentenceJoiner');\nt('common.listJoiner');\nt('goal.sectionAccessibility');\nt('goal.note');\nt('goal.closing');";

/** The Urdu pair for the joining-period cases: a placeholder and a bracket. */
function urduJoins(goal) {
  return {
    common: { sentenceJoiner: '۔ ', listJoiner: '، ' },
    goal: {
      sectionAccessibility: '{{status}}۔ ہدف: {{text}}',
      note: 'دیکھیں Kilo (kilo.ai).',
      closing: 'رپورٹنگ',
      ...goal,
    },
  };
}

test('rejects Urdu copy whose period joins a sentence after a placeholder', () => {
  // The dot follows `{{status}}` rather than an Urdu letter, but a word after
  // it still means a second sentence starts there.
  const found = run({
    language: 'ur',
    english: URDU_JOIN_ENGLISH,
    translated: urduJoins({ sectionAccessibility: '{{status}}. ہدف: {{text}}' }),
    source: URDU_JOIN_SOURCE,
  });
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(
    found.join('\n'),
    /mobile\/ur: "goal\.sectionAccessibility" joins two sentences with the ASCII "\."; Urdu writes «۔»/
  );
});

test('accepts the same sentence joined by «۔» after a placeholder', () => {
  const found = run({
    language: 'ur',
    english: URDU_JOIN_ENGLISH,
    translated: urduJoins(),
    source: URDU_JOIN_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('leaves a value-final period after a closing bracket alone, and a host keeps its dots', () => {
  // `Kilo (kilo.ai).` ends on a bracket rather than on an Urdu word, so its
  // period closes no Urdu sentence and `kilo.ai` carries its own dots, while a
  // value-final period after an Urdu word is still the same defect.
  const clean = run({
    language: 'ur',
    english: URDU_JOIN_ENGLISH,
    translated: urduJoins({ note: 'دیکھیں Kilo (kilo.ai).' }),
    source: URDU_JOIN_SOURCE,
  });
  assert.deepEqual(clean, []);
  const reported = run({
    language: 'ur',
    english: URDU_JOIN_ENGLISH,
    translated: urduJoins({ closing: 'رپورٹنگ.' }),
    source: URDU_JOIN_SOURCE,
  });
  assert.equal(reported.length, 1, reported.join('\n'));
  assert.match(
    reported.join('\n'),
    /mobile\/ur: "goal\.closing" ends a sentence with the ASCII "\."; Urdu writes «۔»/
  );
});

test('leaves an Urdu URL, product name and ellipsis alone', () => {
  const found = run({
    language: 'ur',
    english: URDU_TERMINATORS_ENGLISH,
    translated: urduTerminators({
      ...URDU_TERMINATOR_WORK,
      // A host and a file name continue after their dot, and a product name
      // ends on a Latin letter rather than on an Urdu word.
      host: 'یہ لنک کھولیں: kilo.ai',
      note: 'رپورٹنگ Sentry.',
      file: 'فائل.png',
      waiting: 'انتظار...',
    }),
    source: URDU_TERMINATORS_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('holds only the catalog that declares «۔» as its sentence joiner', () => {
  const found = run({
    language: 'ar',
    english: URDU_TERMINATORS_ENGLISH,
    translated: {
      common: { sentenceJoiner: '.', listJoiner: '، ' },
      work: { ...URDU_TERMINATOR_WORK, empty: 'لا يوجد شيء للقيام به.' },
    },
    source: URDU_TERMINATORS_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('rejects a notification catalog the push locale registry omits', () => {
  const found = run({
    extraFiles: {
      'packages/notifications/src/i18n.ts': [
        `import en from './locales/en.json';`,
        `import ru from './locales/ru.json';`,
        `const pushCatalogs = { 'en': en };`,
      ].join('\n'),
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications: catalog "ru\.json" has no push locale registry entry/
  );
});

test('rejects a push locale registry entry with no catalog import', () => {
  const found = run({
    extraFiles: {
      'packages/notifications/src/i18n.ts': [
        `import en from './locales/en.json';`,
        `import ru from './locales/ru.json';`,
        `const pushCatalogs = { 'en': en, 'ru': ru, 'de': ru };`,
      ].join('\n'),
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications: the push locale registry names "de" with no catalog/
  );
});

test('rejects a notification catalog file the push locale module does not import', () => {
  const found = run({
    extraFiles: {
      'packages/notifications/src/i18n.ts': [
        `import en from './locales/en.json';`,
        `const pushCatalogs = { 'en': en };`,
      ].join('\n'),
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications: catalog "ru\.json" has no import in packages\/notifications\/src\/i18n\.ts/
  );
});

test('rejects a push locale registry entry bound to another catalog', () => {
  const found = run({
    extraFiles: {
      'packages/notifications/src/i18n.ts': [
        `import en from './locales/en.json';`,
        `import ru from './locales/ru.json';`,
        `const pushCatalogs = { 'en': en, 'ru': en };`,
      ].join('\n'),
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications: the push locale registry binds "ru" to "en" instead of the "ru" catalog import/
  );
});

test('reports an unparseable push locale registry as its parse error only', () => {
  const found = run({
    translated: translatedWithGap(),
    extraFiles: {
      'packages/notifications/src/i18n.ts': [
        `import en from './locales/en.json';`,
        `import ru from './locales/ru.json';`,
        `const pushCatalogs = { 'en': en, 'ru': ru`,
      ].join('\n'),
    },
  });
  // The tree a refused parse yields is empty, so the registry walk would find no
  // `pushCatalogs` and report a missing registry on top of the parse error that
  // already names the cause. The rest of the audit still reports its own lines.
  const text = found.join('\n');
  assert.match(text, /packages\/notifications\/src\/i18n\.ts:3: cannot parse: /);
  assert.doesNotMatch(text, /no push locale registry named/);
  assert.match(text, /mobile\/ru: missing key "agents\.title"/);
});

test('rejects a push locale registry with no initializer', () => {
  const found = run({
    extraFiles: {
      'packages/notifications/src/i18n.ts': [
        `import en from './locales/en.json';`,
        `import ru from './locales/ru.json';`,
        `let pushCatalogs;`,
      ].join('\n'),
    },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications\/src\/i18n\.ts: the push locale registry has no initializer/
  );
});

// The push catalog binds its keys two ways: a literal handed to
// `translatePush`, and a payload `i18nKey` base that the worker and the app
// expand to `.title`/`.body`. `translatePush` returns its fallback for a key the
// catalog does not define, so the lock screen would carry English copy and no
// check would say so. Both directions of the usage check read that shape here.
const PUSH_ENGLISH = {
  generic: { title: 'Kilo', body: { chatMessage: 'You have a new message' } },
};
const PUSH_TRANSLATED = {
  generic: { title: 'Kilo', body: { chatMessage: 'Tienes un mensaje nuevo' } },
};
const PUSH_SOURCE = [
  "translatePush(locale, 'generic.title', undefined, 'Kilo');",
  "translatePush(locale, 'generic.body.chatMessage', undefined, 'You have a new message');",
].join('\n');

test('accepts a push key the source passes to translatePush', () => {
  const found = run({
    pushEnglish: PUSH_ENGLISH,
    pushTranslated: PUSH_TRANSLATED,
    pushSource: PUSH_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('rejects a push key no catalog defines, which would ship its English fallback', () => {
  const found = run({
    pushEnglish: PUSH_ENGLISH,
    pushTranslated: PUSH_TRANSLATED,
    pushSource: `${PUSH_SOURCE}\ntranslatePush(locale, 'generic.body.chatMesage', undefined, 'x');`,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications: source uses "generic\.body\.chatMesage", which en\.json does not define/
  );
});

test('rejects an English push key no source uses', () => {
  const found = run({
    pushEnglish: {
      generic: {
        title: 'Kilo',
        body: {
          chatMessage: 'You have a new message',
          scheduledAction: 'A scheduled action has an update',
        },
      },
    },
    pushTranslated: {
      generic: {
        title: 'Kilo',
        body: {
          chatMessage: 'Tienes un mensaje nuevo',
          scheduledAction: 'Una acción programada tiene una actualización',
        },
      },
    },
    pushSource: PUSH_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications: en\.json defines "generic\.body\.scheduledAction", which no source file uses/
  );
});

test('accepts a push key no source names in full, because the payload carries its base', () => {
  // A producer sends `i18nKey: 'sessionReady'`; the worker appends `.title` and
  // `.body`. Both halves of the family are used, so neither is dead copy.
  const found = run({
    pushEnglish: {
      sessionReady: {
        title: '{{sessionTitle}}',
        body: 'Your Kilo session is ready to control from your phone',
      },
    },
    pushTranslated: {
      sessionReady: {
        title: '{{sessionTitle}}',
        body: 'Tu sesión de Kilo está lista para controlarla desde tu teléfono',
      },
    },
    pushSource: "const push = { i18nKey: 'sessionReady' };",
  });
  assert.deepEqual(found, []);
});

test('accepts a push source that builds its key from the payload', () => {
  // `translatePush(locale, `${i18nKey}.title`)` is the mechanism the catalog
  // exists for, not a key the audit can read. It must not be reported.
  const found = run({
    pushEnglish: PUSH_ENGLISH,
    pushTranslated: PUSH_TRANSLATED,
    pushSource: [
      PUSH_SOURCE,
      'const title = translatePush(locale, `${base}.title`, params, stored);',
    ].join('\n'),
  });
  assert.deepEqual(found, []);
});

test('accepts a leaf table whose built key the source names at runtime', () => {
  // The catalog leaf lives in a table and the key is built from it. The leaf
  // literal beside the built head is the only place the key is named, so the
  // dead-key rule must read both together.
  const found = run({
    pushEnglish: PUSH_ENGLISH,
    pushTranslated: PUSH_TRANSLATED,
    pushSource: [
      "translatePush(locale, 'generic.title', undefined, 'Kilo');",
      "const LEAF_BY_TYPE = { 'chat.message': 'chatMessage' };",
      'const leaf = LEAF_BY_TYPE[type];',
      'translatePush(locale, `generic.body.${leaf}`, undefined, en.generic.body[leaf]);',
    ].join('\n'),
  });
  assert.deepEqual(found, []);
});

test('rejects a push key under a built head that no leaf names', () => {
  const found = run({
    pushEnglish: {
      generic: {
        title: 'Kilo',
        body: {
          chatMessage: 'You have a new message',
          scheduledAction: 'A scheduled action has an update',
        },
      },
    },
    pushTranslated: {
      generic: {
        title: 'Kilo',
        body: {
          chatMessage: 'Tienes un mensaje nuevo',
          scheduledAction: 'Una acción programada tiene una actualización',
        },
      },
    },
    pushSource: [
      "const LEAF_BY_TYPE = { 'chat.message': 'chatMessage' };",
      'const leaf = LEAF_BY_TYPE[type];',
      'translatePush(locale, `generic.body.${leaf}`, undefined, en.generic.body[leaf]);',
    ].join('\n'),
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications: en\.json defines "generic\.body\.scheduledAction", which no source file uses/
  );
});

test('rejects a push value left in English in one locale', () => {
  // The mobile rule only fires when a value is English in every locale, which a
  // single untranslated locale never is.
  const found = run({
    pushEnglish: {
      internal: {
        lowBalance: {
          title: 'Low balance alert',
          body: '{{organizationName}} balance fell below ${{minimumBalanceUsd}}',
        },
      },
    },
    pushTranslated: {
      internal: {
        lowBalance: {
          title: 'Low balance alert',
          body: 'El saldo de {{organizationName}} cayó por debajo de ${{minimumBalanceUsd}}',
        },
      },
    },
    pushSource: "const push = { i18nKey: 'internal.lowBalance' };",
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications\/ru: "internal\.lowBalance\.title" is English; translate it/
  );
});

test('accepts a one-token push value that reads the same in every language', () => {
  // A product name and a bare placeholder carry no grammar to translate.
  const found = run({
    pushEnglish: { generic: { title: 'Kilo' }, sessionReady: { title: '{{sessionTitle}}' } },
    pushTranslated: { generic: { title: 'Kilo' }, sessionReady: { title: '{{sessionTitle}}' } },
    pushSource: [
      "translatePush(locale, 'generic.title', undefined, 'Kilo');",
      "const push = { i18nKey: 'sessionReady' };",
    ].join('\n'),
  });
  assert.deepEqual(found, []);
});

// One key per piece of copy holds for the push catalog too: two producers that
// state the same thing read one entry, or a translator can drift them apart.
const DUPLICATE_PUSH_ENGLISH = {
  generic: { title: 'Kilo', body: { securityUpdate: 'A security check has an update' } },
  internal: { securityLifecycle: { title: 'Kilo', body: 'A security check has an update' } },
};
const DUPLICATE_PUSH_SOURCE = [
  "translatePush(locale, 'generic.title', undefined, 'Kilo');",
  "translatePush(locale, 'generic.body.securityUpdate', undefined, 'A security check has an update');",
  "const push = { i18nKey: 'internal.securityLifecycle' };",
].join('\n');

test('rejects two push keys that hold one piece of copy', () => {
  const found = run({
    pushEnglish: DUPLICATE_PUSH_ENGLISH,
    pushTranslated: {
      generic: { title: 'Kilo', body: { securityUpdate: 'Проверка безопасности обновилась' } },
      internal: { securityLifecycle: { title: 'Kilo', body: 'Обновление проверки безопасности' } },
    },
    pushSource: DUPLICATE_PUSH_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications\/en: 2 keys hold the copy "A security check has an update"/
  );
});

// The prefix expansion reads one snapshot of the literals: `b.` then `a.` over
// the literal `c` builds `b.c` and `a.c`, never `a.b.c`.
test('rejects a push key that only a second prefix pass would synthesize', () => {
  const found = run({
    pushEnglish: { a: { b: { c: 'Translated elsewhere' } } },
    pushTranslated: { a: { b: { c: 'Переведено' } } },
    pushSource: [
      "const leaf = 'c';",
      'translatePush(locale, `b.${leaf}`, undefined, stored);',
      'translatePush(locale, `a.${leaf}`, undefined, stored);',
    ].join('\n'),
  });
  assert.match(
    found.join('\n'),
    /^notifications: en\.json defines "a\.b\.c", which no source file uses$/m
  );
});

// The exemption is looked up through wording(), so the remedy has to print that
// same folded form: adding the raw copy would leave the duplicate in place.
test('names the folded copy in the duplicate-copy remedy', () => {
  const found = run({
    english: { agents: { title: 'Cancel' }, profile: { action: 'Cancel' } },
    translated: { agents: { title: 'Отмена' }, profile: { action: 'Отменить' } },
    source: "t('agents.title');\nt('profile.action');",
  });
  const text = found.join('\n');
  assert.match(text, /or add "cancel" to TWO_SENSE_COPY in tools\/i18n\/check-catalogs\.mjs/);
  assert.ok(
    text.includes(
      ' (entries are compared after trimming, case folding and dropping trailing sentence punctuation)'
    ),
    'the remedy explains how the entry is compared'
  );

  // A copy the fold leaves alone is printed as it stands, with no explanation.
  const plain = run({
    english: { agents: { title: 'not now' }, profile: { action: 'not now' } },
    translated: { agents: { title: 'не сейчас' }, profile: { action: 'не сейчас' } },
    source: "t('agents.title');\nt('profile.action');",
  }).join('\n');
  assert.match(plain, /or add "not now" to TWO_SENSE_COPY/);
  assert.ok(!plain.includes('entries are compared after trimming'), 'no note when nothing folds');
});

test('accepts push producers that read one shared key', () => {
  // Both session producers state the session title, so one entry carries it and
  // each payload names its own base.
  const found = run({
    pushEnglish: {
      session: { title: '{{sessionTitle}}' },
      agentSession: { notification: { body: '{{message}}' } },
      sessionReady: { body: 'Your Kilo session is ready to control from your phone' },
    },
    pushTranslated: {
      session: { title: '{{sessionTitle}}' },
      agentSession: { notification: { body: '{{message}}' } },
      sessionReady: { body: 'Сессия Kilo готова к управлению с телефона' },
    },
    pushSource: [
      "const sessionPush = { i18nKey: 'agentSession.notification' };",
      "const readyPush = { i18nKey: 'sessionReady' };",
      "translatePush(locale, 'session.title', undefined, '{{sessionTitle}}');",
    ].join('\n'),
  });
  assert.deepEqual(found, []);
});

// A language whose preposition for this message is the English word keeps the
// copy: reviewed per (value, tag) in NOTIFICATIONS_ENGLISH_COPY_EXCEPTIONS.
const SHARED_PREPOSITION_ENGLISH = {
  internal: {
    securityFindingNew: {
      title: 'New security finding ({{severity}})',
      body: '{{findingTitle}} in {{repoFullName}}',
    },
  },
};
const SHARED_PREPOSITION_SOURCE = "const push = { i18nKey: 'internal.securityFindingNew' };";
const SINGLE_ENGLISH = { agents: { title: 'Agents' } };
const SINGLE_SOURCE = "t('agents.title');";

test('accepts a push value a reviewed exception lists for its language', () => {
  const found = run({
    english: SINGLE_ENGLISH,
    translated: { agents: { title: 'Agenten' } },
    source: SINGLE_SOURCE,
    language: 'de',
    pushEnglish: SHARED_PREPOSITION_ENGLISH,
    pushTranslated: {
      internal: {
        securityFindingNew: {
          title: 'Neue Sicherheitsfeststellung ({{severity}})',
          body: '{{findingTitle}} in {{repoFullName}}',
        },
      },
    },
    pushSource: SHARED_PREPOSITION_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('still rejects that push value in a language the exceptions do not list', () => {
  const found = run({
    english: SINGLE_ENGLISH,
    translated: { agents: { title: 'Агенты' } },
    source: SINGLE_SOURCE,
    language: 'ru',
    pushEnglish: SHARED_PREPOSITION_ENGLISH,
    pushTranslated: {
      internal: {
        securityFindingNew: {
          title: 'Новая находка ({{severity}})',
          body: '{{findingTitle}} in {{repoFullName}}',
        },
      },
    },
    pushSource: SHARED_PREPOSITION_SOURCE,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /notifications\/ru: "internal\.securityFindingNew\.body" is English; translate it/
  );
});

// The push title and the app's finding rows show one severity level, so both
// catalogs must spell it the same way. These fixtures carry just the four pairs
// the parity rule compares, with the English words equal on both sides.
const SEVERITY_PARITY_MOBILE_ENGLISH = {
  common: { critical: 'Critical' },
  securityAgent: { sla: { high: 'High', medium: 'Medium', low: 'Low' } },
};
const SEVERITY_PARITY_SOURCE = [
  "t('common.critical');",
  "t('securityAgent.sla.high');",
  "t('securityAgent.sla.medium');",
  "t('securityAgent.sla.low');",
].join('\n');
const SEVERITY_PARITY_PUSH_ENGLISH = {
  internal: {
    securityFindingSeverity: {
      critical: 'Critical',
      high: 'High',
      medium: 'Medium',
      low: 'Low',
    },
  },
};
// The severity keys are string literals in the real producer, so the fixture
// names them the same way and the usage check finds every one.
const SEVERITY_PARITY_PUSH_SOURCE = [
  'const SEVERITY_KEYS = [',
  "  'internal.securityFindingSeverity.critical',",
  "  'internal.securityFindingSeverity.high',",
  "  'internal.securityFindingSeverity.medium',",
  "  'internal.securityFindingSeverity.low',",
  '];',
].join('\n');

test('accepts a severity the push catalog and the mobile catalog spell the same way', () => {
  const found = run({
    english: SEVERITY_PARITY_MOBILE_ENGLISH,
    translated: {
      common: { critical: 'Критично' },
      securityAgent: { sla: { high: 'Высоко', medium: 'Средне', low: 'Низко' } },
    },
    source: SEVERITY_PARITY_SOURCE,
    pushEnglish: SEVERITY_PARITY_PUSH_ENGLISH,
    pushTranslated: {
      internal: {
        securityFindingSeverity: {
          critical: 'Критично',
          high: 'Высоко',
          medium: 'Средне',
          low: 'Низко',
        },
      },
    },
    pushSource: SEVERITY_PARITY_PUSH_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('rejects a severity the push catalog and the mobile catalog spell two ways', () => {
  const found = run({
    english: SEVERITY_PARITY_MOBILE_ENGLISH,
    translated: {
      common: { critical: 'Критично' },
      securityAgent: { sla: { high: 'Высоко', medium: 'Средне', low: 'Низко' } },
    },
    source: SEVERITY_PARITY_SOURCE,
    pushEnglish: SEVERITY_PARITY_PUSH_ENGLISH,
    pushTranslated: {
      internal: {
        securityFindingSeverity: {
          critical: 'Критично',
          high: 'Высокий',
          medium: 'Средне',
          low: 'Низко',
        },
      },
    },
    pushSource: SEVERITY_PARITY_PUSH_SOURCE,
  });
  assert.deepEqual(found, [
    'notifications/ru: "internal.securityFindingSeverity.high" reads "Высокий" but mobile "securityAgent.sla.high" reads "Высоко"',
  ]);
});

// Two non-English catalogs let a case leave one of them in English while the
// other translates the same key. The every-locale rule then stays silent (the
// value is not identical everywhere), so only the per-catalog rule can see the
// catalog that never translated.
const PER_CATALOG_LANGUAGES = "export const SUPPORTED_LANGUAGES = ['en', 'fr', 'ru'];";
const PER_CATALOG_PUSH_REGISTRY = [
  "import en from './locales/en.json';",
  "import fr from './locales/fr.json';",
  "import ru from './locales/ru.json';",
  "const pushCatalogs = { 'en': en, 'fr': fr, 'ru': ru };",
].join('\n');
const PER_CATALOG_FRENCH_PUSH = {
  'packages/notifications/src/locales/fr.json': '{}',
  'packages/notifications/src/i18n.ts': PER_CATALOG_PUSH_REGISTRY,
};

/** The audit over a tree whose French catalog may keep a value in English. */
function runWithFrench({ english, french, russian, source }) {
  return run({
    english,
    translated: russian,
    source,
    extraFiles: {
      ...PER_CATALOG_FRENCH_PUSH,
      'apps/mobile/src/i18n/languages.ts': PER_CATALOG_LANGUAGES,
      'apps/mobile/src/i18n/locales/fr.json': JSON.stringify(french),
    },
  });
}

test('rejects a mobile value one catalog left in English while another translated it', () => {
  const found = runWithFrench({
    english: { agents: { title: 'Your agents' } },
    french: { agents: { title: 'Your agents' } },
    russian: { agents: { title: 'Ваши агенты' } },
    source: "t('agents.title');",
  });
  assert.ok(
    found.includes(
      'mobile/fr: "agents.title" is English; translate it, or list the value for "fr" in MOBILE_ENGLISH_COPY_EXCEPTIONS'
    ),
    found.join('\n')
  );
  assert.ok(!found.some(problem => problem.startsWith('mobile/ru:')), found.join('\n'));
  assert.ok(
    !found.some(problem => problem.includes('equals English in every locale')),
    'the every-locale rule must stay silent when one catalog translated the key'
  );
});

test('accepts that value translated in the catalog that kept it', () => {
  const found = runWithFrench({
    english: { agents: { title: 'Your agents' } },
    french: { agents: { title: 'Vos agents' } },
    russian: { agents: { title: 'Ваши агенты' } },
    source: "t('agents.title');",
  });
  assert.deepEqual(found, []);
});

test('accepts an allowlisted proper noun left in English in one catalog', () => {
  // `agentChat.toolCard.toolBash` is allowlisted and its value is a bare
  // lowercase word, so this case proves the allowlist skip rather than the
  // prose skip. `profile.providerApple` is the brief's own example; its value
  // carries no prose, so it passes whichever skip runs first.
  const found = runWithFrench({
    english: {
      agentChat: { toolCard: { toolBash: 'bash' } },
      profile: { providerApple: 'Apple' },
    },
    french: {
      agentChat: { toolCard: { toolBash: 'bash' } },
      profile: { providerApple: 'Apple' },
    },
    russian: {
      agentChat: { toolCard: { toolBash: 'терминал' } },
      profile: { providerApple: 'Эппл' },
    },
    source: "t('agentChat.toolCard.toolBash');\nt('profile.providerApple');",
  });
  assert.deepEqual(found, []);
});

test('accepts a placeholder-only and a capitalised product name left in English', () => {
  const found = runWithFrench({
    english: { agents: { tokenOnly: '{{name}}', brand: 'Kilo Code' } },
    french: { agents: { tokenOnly: '{{name}}', brand: 'Kilo Code' } },
    russian: { agents: { tokenOnly: '{{name}} привет', brand: 'Кило Код' } },
    source: "t('agents.tokenOnly');\nt('agents.brand');",
  });
  assert.deepEqual(found, []);
});

test('accepts a mobile value its catalog lists as English on purpose', () => {
  const english = { prReview: { terms: { mergeRequest: 'Merge request' } } };
  const russian = { prReview: { terms: { mergeRequest: 'Запрос на слияние' } } };
  const source = "t('prReview.terms.mergeRequest');";
  const problem =
    'mobile/fr: "prReview.terms.mergeRequest" is English; translate it, or list the value for "fr" in MOBILE_ENGLISH_COPY_EXCEPTIONS';

  // With the shipped, empty map the value is reported, so the case below proves
  // the exception entry is what accepts it.
  const reported = runWithFrench({ english, french: english, russian, source });
  assert.ok(reported.includes(problem), reported.join('\n'));

  // The shipped map already holds entries, so the case swaps the whole literal
  // body for one that names only the value this fixture audits: the fixture's
  // own assertion then proves the entry is what accepts the value.
  const mapBody = /const MOBILE_ENGLISH_COPY_EXCEPTIONS = \{[\s\S]*?\n\};/.exec(
    CHECKER_SOURCE
  )?.[0];
  assert.ok(mapBody, 'the shipped checker ships the exception map literal');
  const withException = CHECKER_SOURCE.replace(
    mapBody,
    [
      'const MOBILE_ENGLISH_COPY_EXCEPTIONS = {',
      "  fr: { 'Merge request': 'the Git noun French keeps in English' },",
      '};',
    ].join('\n')
  );
  assert.notEqual(withException, CHECKER_SOURCE, 'the case must fill the exception map');
  const root = cliFixture(
    {
      ...standardFiles({ english, translated: russian, source }),
      ...PER_CATALOG_FRENCH_PUSH,
      'apps/mobile/src/i18n/languages.ts': PER_CATALOG_LANGUAGES,
      'apps/mobile/src/i18n/locales/fr.json': JSON.stringify(english),
    },
    withException
  );
  const result = cli(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('stays silent when every catalog lists the prose value as English on purpose', () => {
  // A reviewed entry is the decision that the value stays English in that
  // catalog, so a key every catalog exempts is not a defect. Only the per-locale
  // rule reads the map, which is why it, and not the every-locale rule, decides
  // what a prose value means.
  const english = { agents: { title: 'Your agents' } };
  const source = "t('agents.title');";
  const mapBody = /const MOBILE_ENGLISH_COPY_EXCEPTIONS = \{[\s\S]*?\n\};/.exec(
    CHECKER_SOURCE
  )?.[0];
  assert.ok(mapBody, 'the shipped checker ships the exception map literal');
  const filled = entries => {
    const patched = CHECKER_SOURCE.replace(
      mapBody,
      ['const MOBILE_ENGLISH_COPY_EXCEPTIONS = {', ...entries, '};'].join('\n')
    );
    assert.notEqual(patched, CHECKER_SOURCE, 'the case must fill the exception map');
    return patched;
  };
  const tree = checker =>
    cliFixture(
      {
        ...standardFiles({ english, translated: english, source }),
        ...PER_CATALOG_FRENCH_PUSH,
        'apps/mobile/src/i18n/languages.ts': PER_CATALOG_LANGUAGES,
        'apps/mobile/src/i18n/locales/fr.json': JSON.stringify(english),
        'apps/mobile/src/i18n/locales/ru.json': JSON.stringify(english),
      },
      checker
    );

  const both = cli(
    tree(filled([`  fr: { 'Your agents': 'reviewed' },`, `  ru: { 'Your agents': 'reviewed' },`]))
  );
  assert.equal(both.status, 0, both.stderr);
  assert.equal(both.stderr, '');

  // One catalog without the entry still reports, so the silence above is the
  // reviewed entry's doing and not a rule that stopped seeing the value.
  const one = cli(tree(filled([`  fr: { 'Your agents': 'reviewed' },`])));
  assert.equal(one.status, 1, one.stderr);
  assert.match(
    one.stderr,
    /^mobile\/ru: "agents\.title" is English; translate it, or list the value for "ru" in MOBILE_ENGLISH_COPY_EXCEPTIONS$/m
  );
  assert.doesNotMatch(one.stderr, /^mobile\/fr: /m);
  assert.doesNotMatch(one.stderr, /equals English in every locale/);
});

test('reports one line per locale for a prose value left in English everywhere', () => {
  const found = run({
    english: { agents: { title: 'Your agents' } },
    translated: { agents: { title: 'Your agents' } },
    source: "t('agents.title');",
  });
  assert.ok(
    found.includes(
      'mobile/ru: "agents.title" is English; translate it, or list the value for "ru" in MOBILE_ENGLISH_COPY_EXCEPTIONS'
    ),
    found.join('\n')
  );
  assert.ok(
    !found.some(line => line.includes('equals English in every locale')),
    `a prose value is reported per locale:\n${found.join('\n')}`
  );
});

test('reports a value with no prose once, for every locale', () => {
  // Nothing in a bare placeholder can be translated, so no locale can fix it:
  // the per-locale rule says nothing and the every-locale rule names the key.
  const found = run({
    english: { agents: { tokenOnly: '{{name}}' } },
    translated: { agents: { tokenOnly: '{{name}}' } },
    source: "t('agents.tokenOnly');",
  });
  assert.ok(
    found.includes('mobile: "agents.tokenOnly" equals English in every locale'),
    found.join('\n')
  );
  assert.ok(
    !found.some(line => line.includes('is English; translate it')),
    `a value with no prose has nothing to translate per locale:\n${found.join('\n')}`
  );
});

test('importing the module reads and audits nothing', () => {
  // A root holding only the checker and its shared modules: no catalogs, no
  // wording exceptions, no source tree. Anything the module does on import
  // beyond declaring its exports fails here.
  const root = fixture({});
  mkdirSync(join(root, 'tools/i18n'), { recursive: true });
  mkdirSync(join(root, 'tools/lib'), { recursive: true });
  for (const name of SHARED_MODULES) {
    copyFileSync(new URL(`../lib/${name}`, import.meta.url), join(root, `tools/lib/${name}`));
  }
  copyFileSync(
    new URL('./check-catalogs.mjs', import.meta.url),
    join(root, 'tools/i18n/check-catalogs.mjs')
  );
  // The parser resolves, because importing the checker loads the scanner.
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'probe.mjs'), "import './tools/i18n/check-catalogs.mjs';\n");
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

test('reports a matching catalog tree through the command', () => {
  const root = cliFixture(standardFiles());
  const result = cli(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /check-catalogs: 2 languages, every catalog matches en\.json/);
});

test('reports a broken catalog through the command and exits non-zero', () => {
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.title;
  const root = cliFixture(standardFiles({ translated }));
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mobile\/ru: missing key "agents\.title"/);
  assert.match(result.stderr, /check-catalogs: \d+ problem\(s\)/);
});

test('writes the whole report before it sets the failing exit status', async () => {
  // The report must survive the pipe: the reader here takes the output while
  // the command runs, so a forced exit abandons everything past one pipe
  // buffer and the tail of a long report never arrives. Every generated key is
  // missing from the Russian catalog and used by no source.
  const english = { ...ENGLISH };
  for (let index = 0; index < 10_000; index += 1) {
    english[`problem${index}`] = `Unused copy ${index}`;
  }
  const root = cliFixture(standardFiles({ english }));
  const result = await cliStreamed(root, {
    env: { ...process.env, I18N_CHECK_LIMIT: '100000' },
  });
  assert.equal(result.status, 1);
  // The floor asks for several pipe buffers, not for this fixture's exact size:
  // the case is about the tail of a report that no single buffer can hold.
  assert.ok(result.stderr.length > 256 * 1024, `stderr was ${result.stderr.length} bytes`);
  assert.match(result.stderr, /mobile\/ru: missing key "problem9999"/);
  assert.match(result.stderr, /check-catalogs: \d+ problem\(s\)\n$/);
});

test('reports a directory named like a catalog through the command and skips it', () => {
  // `catalogTags` counts only regular files, and the membership rule names the
  // directory itself, so the run prints one line and exits 1 instead of
  // reading the directory as a catalog (a stack trace) or passing silently.
  const root = cliFixture({
    ...standardFiles(),
    'apps/mobile/src/i18n/locales/xx.json/keep.txt': '',
  });
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /mobile: catalog "xx\.json" is not a regular file; remove it or make it a catalog/
  );
  assert.doesNotMatch(result.stderr, /EISDIR|mobile\/xx/);
  assert.match(result.stderr, /check-catalogs: \d+ problem\(s\)/);
});

test('reports a locale file the filesystem refuses through the command', () => {
  // The read sits inside the same handling as the JSON.parse it feeds: one
  // problem line here instead of an uncaught ENOENT ending the audit. The
  // unreadable entry is English's own: `checkCatalogs` reads it through
  // `parseCatalog` unconditionally, whatever the tag set says.
  const root = cliFixture(standardFiles());
  rmSync(join(root, 'apps/mobile/src/i18n/locales/en.json'));
  symlinkSync(
    join(root, 'missing-locale-target'),
    join(root, 'apps/mobile/src/i18n/locales/en.json')
  );
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mobile\/en: cannot audit catalog: ENOENT/);
  assert.doesNotMatch(result.stderr, /Error:|at /);
});

test('reports an unreadable supported-language list as one problem line', () => {
  // The path exists but the read refuses it: a directory named like the module.
  // The membership rule would call every catalog file an unsupported language
  // once the list is unknown, so it is skipped and the missing key still shows.
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.title;
  const root = cliFixture(standardFiles({ translated }));
  const languages = join(root, 'apps/mobile/src/i18n/languages.ts');
  rmSync(languages);
  mkdirSync(languages);
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^mobile: cannot audit the supported-language list: EISDIR/m);
  assert.match(result.stderr, /mobile\/ru: missing key "agents\.title"/);
  assert.doesNotMatch(result.stderr, /is not a supported language/);
  assert.doesNotMatch(result.stderr, /^\s+at /m);
});

test('reports a missing supported-language list without inventing unsupported catalogs', () => {
  // A removed file is the other way the tag set is unknown; the membership rule
  // stays off for the same reason, and the run still reports the missing key.
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.title;
  const root = cliFixture(standardFiles({ translated }));
  rmSync(join(root, 'apps/mobile/src/i18n/languages.ts'));
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^mobile: no supported-language list at apps\/mobile\/src\/i18n\/languages\.ts/m
  );
  assert.match(result.stderr, /mobile\/ru: missing key "agents\.title"/);
  assert.doesNotMatch(result.stderr, /is not a supported language/);
  assert.doesNotMatch(result.stderr, /^\s+at /m);
});

test('reports an unreadable push locale registry as one problem line', () => {
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.title;
  const root = cliFixture(standardFiles({ translated }));
  const registry = join(root, 'packages/notifications/src/i18n.ts');
  rmSync(registry);
  mkdirSync(registry);
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^notifications: cannot audit the push locale registry: EISDIR/m);
  assert.match(result.stderr, /mobile\/ru: missing key "agents\.title"/);
  assert.doesNotMatch(result.stderr, /^\s+at /m);
});

test('reports an unreadable catalog folder as one problem line', () => {
  // A listing that throws would end the run. One line names the folder, and
  // the rules that need its tag set skip rather than repeat it per rule.
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.title;
  const root = cliFixture(standardFiles({ translated }));
  rmSync(join(root, 'packages/notifications/src/locales'), { recursive: true });
  const result = cli(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^notifications: cannot audit the catalog folder: ENOENT/m);
  assert.match(result.stderr, /mobile\/ru: missing key "agents\.title"/);
  assert.doesNotMatch(result.stderr, /^\s+at /m);
  const folderLines = result.stderr
    .split('\n')
    .filter(line => line.startsWith('notifications: cannot audit the catalog folder:'));
  assert.equal(folderLines.length, 1, result.stderr);
});

// A confirmation's safe button falls back to the catalog's own Cancel label
// (`cancelLabel ?? t('common.cancel')`), so a destructive label translated with
// that same word leaves the reader two buttons that both read Cancel.
const CONFIRM_ENGLISH = {
  common: { cancel: 'Cancel', keepEditing: 'Keep editing' },
  sessionShare: { revoke: 'Revoke link' },
};
const CONFIRM_SOURCE = [
  "t('common.cancel');",
  "t('common.keepEditing');",
  "confirm({ message: 'Stop sharing?', confirmLabel: t('sessionShare.revoke') });",
].join('\n');
const FRENCH_CANCEL = { cancel: 'Annuler', keepEditing: 'Continuer la modification' };

test('rejects a destructive confirm label that is the catalog’s Cancel word', () => {
  const found = run({
    language: 'fr',
    english: CONFIRM_ENGLISH,
    translated: {
      common: FRENCH_CANCEL,
      sessionShare: { revoke: 'Annuler' },
    },
    source: CONFIRM_SOURCE,
  });
  assert.deepEqual(found, [
    'mobile/fr: "sessionShare.revoke" reads "Annuler", which this catalog already uses for Cancel ("Annuler"); the destructive button must use a verb the locale does not use for Cancel',
  ]);
});

test('rejects a destructive confirm label that contains the Cancel word', () => {
  const found = run({
    language: 'fr',
    english: CONFIRM_ENGLISH,
    translated: {
      common: FRENCH_CANCEL,
      sessionShare: { revoke: 'Annuler le partage' },
    },
    source: CONFIRM_SOURCE,
  });
  assert.deepEqual(found, [
    'mobile/fr: "sessionShare.revoke" reads "Annuler le partage", which this catalog already uses for Cancel ("Annuler"); the destructive button must use a verb the locale does not use for Cancel',
  ]);
});

test('accepts a destructive confirm label with a verb of its own', () => {
  const found = run({
    language: 'fr',
    english: CONFIRM_ENGLISH,
    translated: {
      common: FRENCH_CANCEL,
      sessionShare: { revoke: 'Révoquer le lien' },
    },
    source: CONFIRM_SOURCE,
  });
  assert.deepEqual(found, []);
});

// "Cancel subscription" beside "Cancel" is the shipped English pattern, so
// English anchors the class: a locale may translate this label with its Cancel
// word, because English already tells the reader which action ends. The
// equality test still applies there: a locale that renders the red button with
// nothing but the Cancel word leaves two buttons reading Cancel.
const ANCHORED_ENGLISH = {
  common: { cancel: 'Cancel', keepEditing: 'Keep editing' },
  kiloPass: { manage: { cancel: 'Cancel subscription' } },
};
const ANCHORED_SOURCE = [
  "t('common.cancel');",
  "t('common.keepEditing');",
  "confirm({ message: 'Stop renewing?', confirmLabel: t('kiloPass.manage.cancel') });",
].join('\n');

test('accepts an English confirm label that names the action it cancels', () => {
  const found = run({
    english: ANCHORED_ENGLISH,
    translated: {
      common: { cancel: 'Отмена', keepEditing: 'Продолжить изменение' },
      kiloPass: { manage: { cancel: 'Отмена подписки' } },
    },
    source: ANCHORED_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('rejects an anchored confirm label that is only the catalog’s Cancel word', () => {
  const found = run({
    english: ANCHORED_ENGLISH,
    translated: {
      common: { cancel: 'Отмена', keepEditing: 'Продолжить изменение' },
      kiloPass: { manage: { cancel: 'Отмена' } },
    },
    source: ANCHORED_SOURCE,
  });
  assert.deepEqual(found, [
    'mobile/ru: "kiloPass.manage.cancel" reads "Отмена", which this catalog already uses for Cancel ("Отмена"); the destructive button must use a verb the locale does not use for Cancel',
  ]);
});

// Turkish writes the capital of `i` as `İ` (U+0130), which lowercases to `i`
// plus U+0307; a fold that keeps the mark misses every value spelling the word
// with a plain `i`.
const TURKISH_CANCEL = { cancel: 'İptal', keepEditing: 'Düzenlemeye devam et' };
const TURKISH_ENGLISH = {
  common: { cancel: 'Cancel', keepEditing: 'Keep editing' },
  sessionShare: { revoke: 'Revoke link' },
};

test('rejects a destructive confirm label that spells the dotted Cancel word with a plain i', () => {
  const found = run({
    language: 'tr',
    english: TURKISH_ENGLISH,
    translated: {
      common: TURKISH_CANCEL,
      sessionShare: { revoke: 'Bağlantıyı iptal et' },
    },
    source: CONFIRM_SOURCE,
  });
  assert.deepEqual(found, [
    'mobile/tr: "sessionShare.revoke" reads "Bağlantıyı iptal et", which this catalog already uses for Cancel ("İptal"); the destructive button must use a verb the locale does not use for Cancel',
  ]);
});

test('accepts a Turkish label that names the action beside an anchored Cancel word', () => {
  const found = run({
    language: 'tr',
    english: ANCHORED_ENGLISH,
    translated: {
      common: TURKISH_CANCEL,
      kiloPass: { manage: { cancel: 'Aboneliği iptal et' } },
    },
    source: ANCHORED_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('accepts a destructive label whose every call site names its own cancel label', () => {
  const found = run({
    language: 'fr',
    english: CONFIRM_ENGLISH,
    translated: {
      common: FRENCH_CANCEL,
      sessionShare: { revoke: 'Annuler' },
    },
    source: [
      "t('common.cancel');",
      "t('common.keepEditing');",
      "confirm({ message: 'Stop sharing?', confirmLabel: t('sessionShare.revoke'), cancelLabel: t('common.keepEditing') });",
      "confirm({ message: 'Stop sharing this link?', confirmLabel: t('sessionShare.revoke'), cancelLabel: t('common.keepEditing') });",
    ].join('\n'),
  });
  assert.deepEqual(found, []);
});

test('rejects an Alert destructive button that reads as the Cancel word', () => {
  const found = run({
    language: 'fr',
    english: CONFIRM_ENGLISH,
    translated: {
      common: FRENCH_CANCEL,
      sessionShare: { revoke: 'Annuler' },
    },
    source: [
      "t('common.cancel');",
      "t('common.keepEditing');",
      "Alert.alert('Stop sharing?', undefined, [{ text: t('common.keepEditing'), style: 'cancel' }, { text: t('sessionShare.revoke'), style: 'destructive' }]);",
    ].join('\n'),
  });
  assert.deepEqual(found, [
    'mobile/fr: "sessionShare.revoke" reads "Annuler", which this catalog already uses for Cancel ("Annuler"); the destructive button must use a verb the locale does not use for Cancel',
  ]);
});

// `consent-card.tsx` passes `actions.destructiveLabel` into `confirm()` with no
// `cancelLabel`, so the safe button falls back to Cancel there too; the label
// itself is resolved from an object literal in `consent-mode.ts`.
const CONSENT_ENGLISH = {
  common: { back: 'Back', cancel: 'Cancel' },
  consent: { revokeConsent: 'Revoke consent' },
};
const CONSENT_SOURCE = [
  "t('common.back');",
  "t('common.cancel');",
  "const actions = { primaryLabel: i18n.t('common.back'), destructiveLabel: i18n.t('consent.revokeConsent') };",
  "confirm({ title: 'Revoke consent?', message: 'You will be signed out.', confirmLabel: actions.destructiveLabel });",
].join('\n');

test('rejects a consent destructive label that reads as the Cancel word, and accepts a verb of its own', () => {
  const found = run({
    language: 'fr',
    english: CONSENT_ENGLISH,
    translated: {
      common: { back: 'Retour', cancel: 'Annuler' },
      consent: { revokeConsent: 'Annuler' },
    },
    source: CONSENT_SOURCE,
  });
  assert.deepEqual(found, [
    'mobile/fr: "consent.revokeConsent" reads "Annuler", which this catalog already uses for Cancel ("Annuler"); the destructive button must use a verb the locale does not use for Cancel',
  ]);

  const distinct = run({
    language: 'fr',
    english: CONSENT_ENGLISH,
    translated: {
      common: { back: 'Retour', cancel: 'Annuler' },
      consent: { revokeConsent: 'Révoquer le consentement' },
    },
    source: CONSENT_SOURCE,
  });
  assert.deepEqual(distinct, []);
});

test('reads the supported tags from the array literal, not from a comment inside it', () => {
  const found = run({
    extraFiles: {
      'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = [
  'en',
  // Sentinels: 'xx' is never shipped.
  'ru',
];
`,
    },
  });
  assert.deepEqual(found, []);
});

/**
 * The translated catalog with one mobile key removed, so a case that loses the
 * tag list can show the audit still reports a finding of the catalog's own.
 */
function translatedWithGap() {
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.title;
  return translated;
}

test('reports a SUPPORTED_LANGUAGES element that is not a string literal', () => {
  const found = run({
    extraFiles: {
      'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = ['en', 'ru', ...EXTRA_TAGS];`,
    },
  });
  // One line: an unreadable element leaves the tag list unknown, and the
  // membership rule stays off instead of calling every catalog unsupported.
  assert.deepEqual(found, [
    'apps/mobile/src/i18n/languages.ts: SUPPORTED_LANGUAGES has an element this check cannot read',
  ]);
});

test('reports a missing SUPPORTED_LANGUAGES declaration', () => {
  const found = run({
    extraFiles: {
      'apps/mobile/src/i18n/languages.ts': `export const OTHER_TAGS = ['en', 'ru'];`,
    },
  });
  assert.deepEqual(found, [
    'apps/mobile/src/i18n/languages.ts: SUPPORTED_LANGUAGES is not declared',
  ]);
});

test('reports an undeclared SUPPORTED_LANGUAGES once and still audits the catalogs', () => {
  const found = run({
    translated: translatedWithGap(),
    extraFiles: {
      'apps/mobile/src/i18n/languages.ts': `export const OTHER_TAGS = ['en', 'ru'];`,
    },
  });
  assert.deepEqual(found, [
    'apps/mobile/src/i18n/languages.ts: SUPPORTED_LANGUAGES is not declared',
    'mobile/ru: missing key "agents.title"',
  ]);
});

test('reports a SUPPORTED_LANGUAGES initializer that is not an array literal once', () => {
  const found = run({
    translated: translatedWithGap(),
    extraFiles: {
      'apps/mobile/src/i18n/languages.ts': [
        `const TAGS = ['en', 'ru'];`,
        `export const SUPPORTED_LANGUAGES = TAGS;`,
      ].join('\n'),
    },
  });
  assert.deepEqual(found, [
    'apps/mobile/src/i18n/languages.ts: SUPPORTED_LANGUAGES is not an array literal',
    'mobile/ru: missing key "agents.title"',
  ]);
});

test('reports an unreadable SUPPORTED_LANGUAGES element once and still audits the catalogs', () => {
  const found = run({
    translated: translatedWithGap(),
    extraFiles: {
      'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = ['en', 'ru', ...EXTRA_TAGS];`,
    },
  });
  assert.deepEqual(found, [
    'apps/mobile/src/i18n/languages.ts: SUPPORTED_LANGUAGES has an element this check cannot read',
    'mobile/ru: missing key "agents.title"',
  ]);
});

test('reports an unparseable SUPPORTED_LANGUAGES file as its parse error only', () => {
  const found = run({
    translated: translatedWithGap(),
    extraFiles: {
      'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = ['en', 'ru'\n`,
    },
  });
  // The parse error already names the cause, so "not declared" would repeat it,
  // and the unknown tag list keeps the membership rule off. The tag-list reader
  // and the mobile catalog's own source scan both parse this file, so the line
  // is not counted here.
  const text = found.join('\n');
  assert.match(text, /apps\/mobile\/src\/i18n\/languages\.ts:2: cannot parse: /);
  assert.doesNotMatch(text, /is not declared/);
  assert.doesNotMatch(text, /is not a supported language/);
  assert.match(text, /mobile\/ru: missing key "agents\.title"/);
});

test('reports a catalog file no supported language names in both catalogs', () => {
  const found = run({
    extraFiles: {
      'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = ['en'];`,
    },
  });
  assert.deepEqual(found, [
    'mobile: catalog "ru.json" is not a supported language',
    'notifications: catalog "ru.json" is not a supported language',
  ]);
});

// A catalog file for a tag the supported-language list does not name is the
// membership rule's finding and nothing else: the locale audit never reads it,
// so a stray file reports one line however broken its copy is.
test('audits only the supported tags on disk', () => {
  const found = run({
    language: 'ru',
    extraFiles: {
      'apps/mobile/src/i18n/locales/de.json': JSON.stringify({
        agents: { title: 'Agenten', extra: 'stray' },
      }),
    },
  });
  const text = found.join('\n');
  assert.match(text, /^mobile: catalog "de\.json" is not a supported language$/m);
  assert.doesNotMatch(text, /mobile\/de:/);
  assert.deepEqual(
    found.filter(problem => !problem.startsWith('mobile: catalog "de.json" is not')),
    []
  );
});

// `Intl.PluralRules('pt_BR')` refuses an underscore tag, and so would the
// catalog's own uppercase comparison. One line names the tag; a stack trace
// would not.
test('reports a supported tag Intl refuses as one problem line', () => {
  const found = run({
    language: 'pt_BR',
    extraFiles: {
      'apps/mobile/src/i18n/locales/de.json': JSON.stringify({ agents: { title: 'Agenten' } }),
    },
  });
  const text = found.join('\n');
  assert.match(text, /^mobile\/pt_BR: cannot audit catalog: /m);
  assert.doesNotMatch(text, /^\s+at /m);
  assert.match(text, /^mobile: catalog "de\.json" is not a supported language$/m);
  assert.ok(found.length > 0, 'expected a problem');
});

// A plural family the locale completes with categories English does not ship.
// Each added form passes the same value rules as an English-keyed form, read
// against the family's English reference for its category.
const WINDOW_ENGLISH = {
  agents: {
    title: 'Agents',
    window_one: '{{displayCount}} session since {{start}}',
    window_other: '{{displayCount}} sessions since {{start}}',
  },
};
const WINDOW_TRANSLATED = {
  agents: {
    title: 'Локальные агенты',
    window_one: '{{displayCount}} сессия с {{start}}',
    window_few: '{{displayCount}} сессии с {{start}}',
    window_many: '{{displayCount}} сессий с {{start}}',
    window_other: '{{displayCount}} сессии с {{start}}',
  },
};
const WINDOW_SOURCE = "t('agents.title');\nt('agents.window', { count: 2 });";

/** The window fixture with one added form replaced and extra keys merged in. */
function runWindow(windowFew, extra = {}) {
  return run({
    language: 'ru',
    english: WINDOW_ENGLISH,
    translated: {
      agents: { ...WINDOW_TRANSLATED.agents, window_few: windowFew, ...extra },
    },
    source: WINDOW_SOURCE,
  });
}

test('accepts the added plural forms a locale completes', () => {
  assert.deepEqual(runWindow(WINDOW_TRANSLATED.agents.window_few), []);
});

test('rejects an empty added plural form', () => {
  const found = runWindow('');
  assert.match(found.join('\n'), /^mobile\/ru: "agents\.window_few" is empty$/m);
});

test('rejects an added plural form that drops a placeholder English carries', () => {
  const found = runWindow('{{displayCount}} сессии');
  assert.match(
    found.join('\n'),
    /^mobile\/ru: "agents\.window_few" placeholders differ from English \(displayCount,start\)$/m
  );
});

test('rejects a changed $t() reference in an added plural form', () => {
  const found = runWindow('{{displayCount}} сессии с {{start}} $t(common.back)');
  assert.match(
    found.join('\n'),
    /^mobile\/ru: "agents\.window_few" \$t\(\) references differ from English \(none\)$/m
  );
});

test('rejects a changed $TOKEN token in an added plural form', () => {
  const found = runWindow('{{displayCount}} сессии с {{start}} $ARGUMENTS');
  assert.match(
    found.join('\n'),
    /^mobile\/ru: "agents\.window_few" \$TOKEN expansion tokens differ from English \(none\)$/m
  );
});

test('rejects a different leading space in an added plural form', () => {
  const found = runWindow(' {{displayCount}} сессии с {{start}}');
  assert.match(
    found.join('\n'),
    /^mobile\/ru: "agents\.window_few" leading or trailing space differs from English$/m
  );
});

test('rejects an added plural form that quotes the English label', () => {
  const found = runWindow('{{displayCount}} сессии с {{start}} "Agents"');
  assert.match(
    found.join('\n'),
    /^mobile\/ru: "agents\.window_few" quotes the English label "Agents"; name its key with \$t\(\)$/m
  );
});

// English exempts nothing: a label it spells is a label it can name, so its own
// catalog cannot quote another of its labels either.
test('rejects an English label that quotes another English label', () => {
  const found = run({
    english: {
      agents: { title: 'Agents', mention: 'Ask the "Agents" list' },
    },
    translated: {
      agents: { title: 'Агенты', mention: 'Спросите у списка' },
    },
    source: "t('agents.title');\nt('agents.mention');",
  });
  assert.deepEqual(found, [
    'mobile/en: "agents.mention" quotes the label "Agents"; name its key with $t()',
  ]);
});

// A product name the locale keeps in its own catalog sits in a value barely
// longer than the name, so a translated sentence that quotes it names no
// control the user misses.
test('accepts a locale that quotes a product name its own catalog keeps', () => {
  const found = run({
    english: {
      agents: { brand: 'Kilo', hint: 'Open the Kilo console' },
    },
    translated: {
      agents: { brand: 'Kilo Pass', hint: 'Откройте "Kilo" здесь' },
    },
    source: "t('agents.brand');\nt('agents.hint');",
  });
  assert.deepEqual(found, []);
});

// A zero category words its own answer — "none" beside a noun reads badly — so
// it may drop the family's visible count without a review entry.
test('accepts a zero added form that drops the visible count', () => {
  const found = runWindow(WINDOW_TRANSLATED.agents.window_few, {
    window_zero: 'нет сессий с {{start}}',
  });
  assert.deepEqual(found, []);
});

// Arabic names its dual with a word form, and the review names that key.
test('accepts an added form the worded-count review names', () => {
  const found = run({
    language: 'ar',
    english: WORDED_ENGLISH,
    translated: {
      securityAgent: {
        dashboard: {
          title: 'لوحة المعلومات',
          daysOverdue_zero: 'لا تأخير',
          daysOverdue_one: 'متأخرة يومًا واحدًا',
          daysOverdue_two: 'متأخرة يومين',
          daysOverdue_few: 'متأخرة {{displayCount}} أيام',
          daysOverdue_many: 'متأخرة {{displayCount}} يومًا',
          daysOverdue_other: 'متأخرة {{displayCount}} يوم',
        },
      },
    },
    source: WORDED_SOURCE,
  });
  assert.deepEqual(found, []);
});

test('rejects a dropped count in an unreviewed added form', () => {
  const found = runWindow('сессии с {{start}}');
  assert.match(
    found.join('\n'),
    /^mobile\/ru: "agents\.window_few" drops \{\{displayCount\}\} without a reviewed worded form \(WORDED_COUNTS\)$/m
  );
});

// The registry diagnostics name the catalog they read instead of a hard-coded
// `notifications:`, so a second catalog cannot inherit the wrong name.
test('the registry diagnostics name the catalog', () => {
  assert.doesNotMatch(CHECKER_SOURCE, /notifications: the push locale registry/);
  const found = run({
    extraFiles: {
      'packages/notifications/src/i18n.ts': [
        `import en from './locales/en.json';`,
        `import ru from './locales/ru.json';`,
        `const pushCatalogs = { 'en': en, 'ru': en, 'de': ru };`,
      ].join('\n'),
    },
  });
  const text = found.join('\n');
  assert.match(
    text,
    /^notifications: the push locale registry names "de" with no catalog import$/m
  );
  assert.match(
    text,
    /^notifications: the push locale registry binds "ru" to "en" instead of the "ru" catalog import$/m
  );
});

// A catalog file no supported language names is the membership rule's finding;
// the registry owes it neither an import nor an entry.
test('does not owe a push registry entry to an unsupported catalog file', () => {
  const found = run({
    extraFiles: { 'packages/notifications/src/locales/de.json': '{}' },
  });
  const text = found.join('\n');
  assert.match(text, /^notifications: catalog "de\.json" is not a supported language$/m);
  assert.doesNotMatch(text, /catalog "de\.json" has no import in/);
  assert.doesNotMatch(text, /catalog "de\.json" has no push locale registry entry/);
});

// The count a form must show comes from the whole family, not from the one
// English reference the form is read against: English's `_one` may spell its
// numeral out while `_other` carries the placeholder, and a form that answers
// to the reference with no numeral must still show the count.
test('rejects an added form that drops the family count its reference lacks', () => {
  const found = run({
    language: 'ru',
    english: {
      agents: {
        title: 'Agents',
        items_one: 'one item',
        items_other: '{{displayCount}} items',
      },
    },
    translated: {
      agents: {
        title: 'Локальные агенты',
        items_one: 'один элемент',
        items_few: 'несколько элементов',
        items_many: '{{displayCount}} элементов',
        items_other: '{{displayCount}} элементов',
      },
    },
    source: "t('agents.title');\nt('agents.items', { count: 2 });",
  });
  const text = found.join('\n');
  assert.match(
    text,
    /^mobile\/ru: "agents\.items_few" drops \{\{displayCount\}\} without a reviewed worded form \(WORDED_COUNTS\)$/m
  );
  // One line for the value: the specific count message replaces the general one.
  assert.doesNotMatch(text, /"agents\.items_few" placeholders differ from English/);
});

// The changelog sentence joins the areas a release touched with
// `Intl.ListFormat`, so an area label that carries the catalog's own list
// conjunction doubles it and the reader cannot tell the areas apart.
const CHANGELOG_AREAS = {
  profile: {
    changelogFixesIn: 'Fixes and improvements in {{areas}}.',
    changelogAreas: {
      signIn: 'Sign-in',
      profileOrganizations: 'Profile & organizations',
    },
  },
};
const CHANGELOG_AREAS_SOURCE = [
  "t('profile.changelogFixesIn', { areas });",
  "t('profile.changelogAreas.signIn');",
  "t('profile.changelogAreas.profileOrganizations');",
].join('\n');

test('accepts a changelog area label that joins its nouns without the list conjunction', () => {
  const found = run({
    language: 'hi',
    english: { common: { sentenceJoiner: '. ' }, ...CHANGELOG_AREAS },
    translated: {
      common: { sentenceJoiner: '। ' },
      profile: {
        changelogFixesIn: '{{areas}} में त्रुटि-सुधार और बेहतरी।',
        changelogAreas: { signIn: 'साइन-इन', profileOrganizations: 'प्रोफ़ाइल व संगठन' },
      },
    },
    source: `${CHANGELOG_AREAS_SOURCE}\nt('common.sentenceJoiner');`,
  });
  assert.deepEqual(found, []);
});

test('rejects a changelog area label that carries the catalog list conjunction', () => {
  const found = run({
    language: 'hi',
    english: { common: { sentenceJoiner: '. ' }, ...CHANGELOG_AREAS },
    translated: {
      common: { sentenceJoiner: '। ' },
      profile: {
        changelogFixesIn: '{{areas}} में त्रुटि-सुधार और बेहतरी।',
        changelogAreas: { signIn: 'साइन-इन', profileOrganizations: 'प्रोफ़ाइल और संगठन' },
      },
    },
    source: `${CHANGELOG_AREAS_SOURCE}\nt('common.sentenceJoiner');`,
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(
    found.join('\n'),
    /^mobile\/hi: "profile\.changelogAreas\.profileOrganizations" contains the list conjunction "और"; the changelog sentence joins the areas itself, so join this label's nouns another way$/m
  );
});

// The rule reads the conjunction from the platform formatter, so a catalog
// whose conjunction is a word of its own is caught as well, and one whose
// label legitimately contains the same letters in another role is not.
test('rejects the English source label that carries "and"', () => {
  const found = run({
    language: 'ru',
    english: {
      profile: {
        changelogFixesIn: 'Fixes and improvements in {{areas}}.',
        changelogAreas: { signIn: 'Sign-in', profileOrganizations: 'Profile and organizations' },
      },
    },
    translated: {
      profile: {
        changelogFixesIn: 'Исправления и улучшения: {{areas}}.',
        changelogAreas: { signIn: 'Вход', profileOrganizations: 'Профиль и организации' },
      },
    },
    source: CHANGELOG_AREAS_SOURCE,
  });
  const text = found.join('\n');
  assert.match(
    text,
    /^mobile\/en: "profile\.changelogAreas\.profileOrganizations" contains the list conjunction "and"/m
  );
  assert.match(
    text,
    /^mobile\/ru: "profile\.changelogAreas\.profileOrganizations" contains the list conjunction "и"/m
  );
});

// The sentence names every area from its own `profile.changelogAreas` key, so
// each of those labels obeys the same rule: a name that carries the
// conjunction splits one area into two.
const CHANGELOG_SHARED_AREAS = {
  profile: {
    changelogFixesIn: 'Fixes and improvements in {{areas}}.',
    changelogAreas: {
      signIn: 'sign-in',
      profileOrganizations: 'profile & organizations',
      chat: 'chat',
      notifications: 'notifications',
      integrations: 'integrations',
    },
  },
};
const CHANGELOG_SHARED_SOURCE = [
  "t('profile.changelogFixesIn', { areas });",
  "t('profile.changelogAreas.signIn');",
  "t('profile.changelogAreas.profileOrganizations');",
  "t('profile.changelogAreas.chat');",
  "t('profile.changelogAreas.notifications');",
  "t('profile.changelogAreas.integrations');",
].join('\n');

test('rejects a shared area label that carries the list conjunction', () => {
  const found = run({
    language: 'fr',
    english: CHANGELOG_SHARED_AREAS,
    translated: {
      profile: {
        changelogFixesIn: 'Corrections et améliorations dans {{areas}}.',
        changelogAreas: {
          signIn: 'Connexion',
          profileOrganizations: 'Profil & organisations',
          chat: 'Discussion et conversation',
          notifications: 'Notifications',
          integrations: 'Intégrations',
        },
      },
    },
    source: CHANGELOG_SHARED_SOURCE,
  });
  assert.match(
    found.join('\n'),
    /^mobile\/fr: "profile\.changelogAreas\.chat" contains the list conjunction "et"; the changelog sentence joins the areas itself/m
  );
});

// The app builds its formatters with a named script or region for two
// catalogs, so the rule has to read the same tag the screen formats with: the
// Serbian catalog is Latin, while a bare `sr` tag resolves to Cyrillic data.
test('reads the Serbian conjunction from the Latin script the app formats with', () => {
  const found = run({
    language: 'sr',
    english: CHANGELOG_SHARED_AREAS,
    translated: {
      profile: {
        changelogFixesIn: 'Ispravke i poboljšanja u {{areas}}.',
        changelogAreas: {
          signIn: 'Prijavljivanje',
          profileOrganizations: 'Profil & organizacije',
          chat: 'Ćaskanje i razgovor',
          notifications: 'Obaveštenja',
          integrations: 'Integracije',
        },
      },
    },
    source: CHANGELOG_SHARED_SOURCE,
  });
  const text = found.join('\n');
  assert.match(
    text,
    /^mobile\/sr: "profile\.changelogAreas\.chat" contains the list conjunction "i"/m
  );
  // The Cyrillic conjunction is not what this catalog renders, so a label that
  // happens to contain it is no finding.
  assert.doesNotMatch(text, /contains the list conjunction "и"/);
});
