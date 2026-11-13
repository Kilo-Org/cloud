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

import { checkCatalogs } from './check-catalogs.mjs';

// The checker parses with oxc through the shared scanner, so the import-only
// probe links the repository's dependency tree at its own root.
const REPO = realpathSync(new URL('../..', import.meta.url).pathname);
const SHARED_MODULES = ['ast.mjs', 'catalogs.mjs', 'source-files.mjs'];
const WORDING_EXCEPTIONS = readFileSync(
  new URL('./wording-exceptions.json', import.meta.url),
  'utf8'
);

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
  extraFiles = {},
} = {}) {
  const root = fixture({
    'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = ['en', '${language}'];`,
    'apps/mobile/src/example.ts': source,
    'apps/mobile/src/i18n/locales/en.json': JSON.stringify(english),
    [`apps/mobile/src/i18n/locales/${language}.json`]: JSON.stringify(translated),
    'packages/notifications/src/locales/en.json': '{}',
    [`packages/notifications/src/locales/${language}.json`]: '{}',
    // The push locale module the catalog checker reads: one import and one
    // registry entry per fixture catalog, as the real module writes them.
    'packages/notifications/src/i18n.ts': [
      `import en from './locales/en.json';`,
      `import ${language.replaceAll('-', '_')} from './locales/${language}.json';`,
      `const pushCatalogs = { 'en': en, '${language}': ${language.replaceAll('-', '_')} };`,
    ].join('\n'),
    'tools/i18n/wording-exceptions.json': WORDING_EXCEPTIONS,
    ...extraFiles,
  });
  return checkCatalogs(root).problems;
}

/**
 * A fixture tree that can run the checker as CI does: a copy of the checker,
 * its shared modules and its wording exceptions, and the repository's
 * dependency tree linked at the root the command resolves from.
 */
function cliFixture(files) {
  const root = fixture({
    ...files,
    'tools/i18n/check-catalogs.mjs': readFileSync(
      new URL('./check-catalogs.mjs', import.meta.url),
      'utf8'
    ),
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

test('rejects an empty translated value', () => {
  const found = run({
    translated: { agents: { ...TRANSLATED.agents, title: '' } },
  });
  assert.ok(found.length > 0, 'expected a problem');
  assert.match(found.join('\n'), /mobile\/ru: "agents\.title" is empty/);
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
