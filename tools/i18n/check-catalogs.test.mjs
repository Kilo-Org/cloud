import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

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

function runChecker(
  context,
  { english = ENGLISH, translated = TRANSLATED, source = SOURCE, language = 'ru' } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'check-catalogs-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const files = {
    'apps/mobile/src/i18n/languages.ts': `export const SUPPORTED_LANGUAGES = ['en', '${language}'];`,
    'apps/mobile/src/example.ts': source,
    'apps/mobile/src/i18n/locales/en.json': JSON.stringify(english),
    [`apps/mobile/src/i18n/locales/${language}.json`]: JSON.stringify(translated),
    'packages/notifications/src/locales/en.json': '{}',
    [`packages/notifications/src/locales/${language}.json`]: '{}',
  };
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  // Preserve the real command and its import.meta.url-based repository layout.
  const toolDir = join(root, 'tools/i18n');
  mkdirSync(toolDir, { recursive: true });
  for (const name of ['check-catalogs.mjs', 'wording-exceptions.json']) {
    copyFileSync(new URL(`./${name}`, import.meta.url), join(toolDir, name));
  }
  const result = spawnSync(process.execPath, [join(toolDir, 'check-catalogs.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

for (const callee of ['t', 'i18n.t']) {
  test(`accepts a plural base called through ${callee} with English siblings`, context => {
    const result = runChecker(context, {
      source: `t('agents.title');\n${callee}('agents.liveCount', { count: 2 });`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /check-catalogs: 2 languages, every catalog matches en\.json/);
  });
}

test('accepts an exact source key without plural siblings', context => {
  const result = runChecker(context, {
    english: { agents: { title: 'Agents' } },
    translated: { agents: { title: 'Localized agents' } },
    source: "t('agents.title');",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

for (const [name, call, key] of [
  ['a missing unrelated source key', "t('profile.missing');", 'profile.missing'],
  ['a nonexistent plural family', "t('agents.missingCount', { count: 2 });", 'agents.missingCount'],
]) {
  test(`rejects ${name}`, context => {
    const result = runChecker(context, { source: `${SOURCE}\n${call}` });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(
      result.stderr.includes(`mobile: source uses "${key}", which en.json does not define`)
    );
  });
}

test('rejects a missing translated English key', context => {
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.title;
  const result = runChecker(context, { translated });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mobile\/ru: missing key "agents\.title"/);
});

test('rejects a missing required locale plural category', context => {
  const translated = { agents: { ...TRANSLATED.agents } };
  delete translated.agents.liveCount_few;
  const result = runChecker(context, { translated });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: plural family "agents\.liveCount" lacks the few category of ru/
  );
});

test('rejects an unused English exact key', context => {
  const result = runChecker(context, { source: "t('agents.liveCount', { count: 2 });" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile: en\.json defines "agents\.title", which no source file uses/
  );
});

test('rejects unused English plural siblings', context => {
  const result = runChecker(context, { source: "t('agents.title');" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile: en\.json defines "agents\.liveCount_one", which no source file uses/
  );
  assert.match(
    result.stderr,
    /mobile: en\.json defines "agents\.liveCount_other", which no source file uses/
  );
});

for (const [language, title, badge] of [
  ['tr', 'Çalışıyor', 'ÇALIŞIYOR'],
  ['az', 'İşləyir', 'İŞLƏYİR'],
  ['el', 'Σε εξέλιξη', 'ΣΕ ΕΞΕΛΙΞΗ'],
  ['de', 'Straße', 'STRASSE'],
]) {
  test(`accepts locale-aware case variants in ${language}`, context => {
    const result = runChecker(context, {
      language,
      english: { title: 'Running', badge: 'RUNNING' },
      translated: { title, badge },
      source: "t('title'); t('badge');",
    });
    assert.equal(result.status, 0, result.stderr);
  });
}

test('still rejects different wording after locale-aware case folding', context => {
  const result = runChecker(context, {
    language: 'tr',
    english: { title: 'Running', badge: 'RUNNING' },
    translated: { title: 'Çalışıyor', badge: 'DURDU' },
    source: "t('title'); t('badge');",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /English "running" is translated 2 ways/);
});

test('rejects the English live-session empty state in a translated catalog', context => {
  const english = { home: { noLiveSessions: 'Nothing running right now' } };
  const result = runChecker(context, {
    english,
    translated: english,
    source: "t('home.noLiveSessions');",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mobile\/ru: "home\.noLiveSessions" must be translated/);
});

test('rejects an empty translated value', context => {
  const result = runChecker(context, {
    translated: { agents: { ...TRANSLATED.agents, title: '' } },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mobile\/ru: "agents\.title" is empty/);
});

test('rejects a translated $TOKEN expansion token', context => {
  const result = runChecker(context, {
    english: { agents: { template: 'Explain $ARGUMENTS' } },
    translated: { agents: { template: 'Explique $ARGUMENTOS' } },
    source: "t('agents.template');",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: "agents\.template" \$TOKEN expansion tokens differ from English \(\$ARGUMENTS\)/
  );
});

test('rejects changed placeholders in an English plural sibling', context => {
  const result = runChecker(context, {
    translated: { agents: { ...TRANSLATED.agents, liveCount_one: '{{total}} localized session' } },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: "agents\.liveCount_one" placeholders differ from English \(count\)/
  );
});

test('rejects unknown placeholders in a locale-specific plural category', context => {
  const result = runChecker(context, {
    translated: {
      agents: { ...TRANSLATED.agents, liveCount_few: '{{total}} localized sessions (few)' },
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
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

test('accepts a category that interpolates the count its English family uses', context => {
  // A language whose singular form also covers 21, 101 and the like has to
  // interpolate the count in `_one`; English spells it out because its `_one`
  // only ever renders at 1.
  const result = runChecker(context, {
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
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('still rejects a token no value of the family uses', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: "agents\.liveCount_one" placeholders differ from English \(none\)/
  );
});

test('still rejects a category that drops a placeholder English requires', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: "agents\.liveCount_other" placeholders differ from English \(count,total\)/
  );
});

const COUNTED = {
  counts: {
    items: '{{count}} items',
    itemsShort: '{{count}}i',
  },
};
const COUNTED_SOURCE = "t('counts.items', { count: 2 });\nt('counts.itemsShort', { count: 2 });";

test('accepts a locale-declared family for a flat counted English key', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('accepts a flat counted key kept untranslated to a family in another locale', context => {
  const result = runChecker(context, {
    english: COUNTED,
    translated: { counts: { items: '{{count}} lokala', itemsShort: '{{count}}l' } },
    source: COUNTED_SOURCE,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('rejects an incomplete locale-declared family for a counted key', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: plural family "counts\.items" lacks the other category of ru/
  );
});

test('rejects a wrong placeholder in a locale-declared counted family', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: "counts\.items_one" uses placeholder \{\{total\}\}, which the English family does not/
  );
});

test('still rejects an unrelated extra key beside a counted family', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mobile\/ru: extra key "counts\.stray" is not in en\.json/);
});
