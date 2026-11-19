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
import test, { after } from 'node:test';

import { flattenCatalog, missingPluralCategories } from '../lib/catalogs.mjs';
import { checkCatalogs } from './check-catalogs.mjs';

// The checker parses with oxc through the shared scanner, so the import-only
// probe links the repository's dependency tree at its own root.
const REPO = realpathSync(new URL('../..', import.meta.url).pathname);
const SHARED_MODULES = ['ast.mjs', 'catalogs.mjs', 'entry-point.mjs', 'source-files.mjs'];
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
  return checkCatalogs(root).problems;
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
    translated: { common: { sentenceJoiner: ' ' }, agents: TRANSLATED.agents },
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
    /mobile\/ru: "agents\.liveCount_few" uses placeholder \{\{total\}\}, which the English family does not/
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
    /mobile\/ru: "counts\.items_one" uses placeholder \{\{total\}\}, which the English family does not/
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

test('still reports a mobile value left in English in every locale', () => {
  const found = run({
    english: { agents: { title: 'Your agents' } },
    translated: { agents: { title: 'Your agents' } },
    source: "t('agents.title');",
  });
  assert.ok(
    found.includes('mobile: "agents.title" equals English in every locale'),
    found.join('\n')
  );
  assert.ok(
    found.includes(
      'mobile/ru: "agents.title" is English; translate it, or list the value for "ru" in MOBILE_ENGLISH_COPY_EXCEPTIONS'
    ),
    found.join('\n')
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

// The descriptor policy guard keeps a misconfigured catalog from throwing: the
// copy rules and the base-key reader are used after the catalogs' value
// problems are collected, so a throw there would hide them. Each case patches
// the notifications descriptor away from the checker source and leaves a mobile
// problem in the tree, so the run must still print what it collected.
const POLICY_PUSH_FILES = {
  'packages/notifications/src/locales/en.json': JSON.stringify({
    internal: { securityFindingNew: { title: 'New finding', body: 'Body' } },
  }),
  'packages/notifications/src/locales/ru.json': JSON.stringify({
    internal: { securityFindingNew: { title: 'Новая находка', body: 'Текст' } },
  }),
  'packages/notifications/src/push-copy.ts': '',
};

// A descriptor-editing patch rewrites the notifications descriptor however the
// upstream source words it: a rule list of one entry or two, a four-space tab,
// or a line the merge moved. A literal replace would pass while patching
// nothing when any of that drifts.
const NOTIFICATIONS_DESCRIPTOR = /name: 'notifications',[\s\S]*?collectsDestructiveKeys: false,\n/;
const editDescriptor = (source, edit) => {
  const descriptors = source.match(new RegExp(NOTIFICATIONS_DESCRIPTOR.source, 'g')) ?? [];
  assert.equal(
    descriptors.length,
    1,
    'the notifications descriptor must be unique in the checker source'
  );
  const edited = edit(descriptors[0]);
  assert.notEqual(edited, descriptors[0], 'the edit must change the descriptor');
  return source.replace(descriptors[0], edited);
};
const WITHOUT_BASE_KEY_DESCRIPTOR = descriptor =>
  descriptor.replace(/^(\s*)baseKeyOf:[^\n]*\n/m, '');

for (const { label, field, patch } of [
  {
    label: 'without a base-key reader',
    field: 'baseKeyOf',
    patch: source => editDescriptor(source, WITHOUT_BASE_KEY_DESCRIPTOR),
  },
  {
    label: 'with an empty copy-rule list',
    field: 'englishCopyRules',
    patch: source =>
      editDescriptor(source, descriptor =>
        descriptor.replace(/(\s*)englishCopyRules:\s*\[[^\]]*\],/, '$1englishCopyRules: [],')
      ),
  },
  {
    label: 'with a non-callable entry in its copy-rule list',
    field: 'englishCopyRules',
    patch: source =>
      editDescriptor(source, descriptor =>
        descriptor.replace(
          /(\s*)englishCopyRules:\s*\[[^\]]*\],/,
          "$1englishCopyRules: [checkPushEnglishCopy, 'not a rule'],"
        )
      ),
  },
]) {
  test(`reports a descriptor ${label} through the command`, () => {
    const patched = patch(CHECKER_SOURCE);
    assert.notEqual(patched, CHECKER_SOURCE, 'the case must change the checker source');
    const translated = { agents: { ...TRANSLATED.agents } };
    delete translated.agents.title;
    const root = cliFixture({ ...standardFiles({ translated }), ...POLICY_PUSH_FILES }, patched);
    const result = cli(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(`notifications: the catalog descriptor declares no usable ${field}`)
    );
    assert.doesNotMatch(result.stderr, /TypeError/);
    assert.match(result.stderr, /mobile\/ru: missing key "agents\.title"/);
  });
}

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
