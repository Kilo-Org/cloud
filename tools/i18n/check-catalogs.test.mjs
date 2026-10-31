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
  {
    english = ENGLISH,
    translated = TRANSLATED,
    source = SOURCE,
    language = 'ru',
    extraFiles = {},
  } = {}
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
    ...extraFiles,
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
  mkdirSync(join(root, 'tools/lib'), { recursive: true });
  copyFileSync(
    new URL('../lib/source-files.mjs', import.meta.url),
    join(root, 'tools/lib/source-files.mjs')
  );
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

test('ignores a mounted-harness helper while a source file still reports its keys', context => {
  const source = "t('agents.missing');\n";
  const inSource = runChecker(context, { source });
  assert.equal(inSource.status, 1, inSource.stderr);
  assert.match(inSource.stderr, /"agents\.missing"/);

  for (const helper of [
    'apps/mobile/src/components/screen.mounted.test-helpers.ts',
    'apps/mobile/src/components/screen.test.tsx',
  ]) {
    const inScaffolding = runChecker(context, { extraFiles: { [helper]: source } });
    assert.equal(inScaffolding.status, 0, inScaffolding.stderr);
    assert.equal(inScaffolding.stderr, '');
  }
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

test('rejects a trailing space that English does not carry', context => {
  const result = runChecker(context, {
    translated: { agents: { ...TRANSLATED.agents, title: 'Localized agents ' } },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mobile\/ru: "agents\.title" leading or trailing space differs/);
});

test('accepts a locale-owned separator in the login legal sentence', context => {
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
  const result = runChecker(context, {
    language: 'zh-Hans',
    english,
    translated: {
      login: { termsPrefix: '继续即表示你同意我们的', terms: '条款', termsConnector: '和' },
    },
    source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('still rejects separator whitespace elsewhere in the same catalog', context => {
  const english = { login: { termsPrefix: 'By continuing you agree to our ', terms: 'Terms' } };
  const result = runChecker(context, {
    language: 'zh-Hans',
    english,
    translated: { login: { termsPrefix: '继续即表示你同意我们的', terms: '条款 ' } },
    source: "t('login.termsPrefix'); t('login.terms');",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mobile\/zh-Hans: "login\.terms" leading or trailing space differs/);
});

for (const [name, termsPrefix, termsConnector] of [
  ['a dropped separator in a spaced catalog', 'Unsere', ' und '],
  ['a padded prefix beside a bare conjunction', 'Unsere ', 'und'],
]) {
  test(`rejects ${name}`, context => {
    const english = {
      login: {
        termsPrefix: 'By continuing you agree to our ',
        terms: 'Terms',
        termsConnector: ' and ',
      },
    };
    const result = runChecker(context, {
      language: 'de',
      english,
      translated: { login: { termsPrefix, terms: 'Bedingungen', termsConnector } },
      source: "t('login.termsPrefix'); t('login.terms'); t('login.termsConnector');",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /mobile\/de: "login\.termsPrefix" and "login\.termsConnector" disagree about their separator/
    );
  });
}

test('accepts a spaced catalog that pads both separator keys', context => {
  const english = {
    login: {
      termsPrefix: 'By continuing you agree to our ',
      terms: 'Terms',
      termsConnector: ' and ',
    },
  };
  const result = runChecker(context, {
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
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
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

test('accepts the reviewed plural forms that say their count in a word', context => {
  const result = runChecker(context, {
    english: WORDED_ENGLISH,
    translated: WORDED_TRANSLATED,
    source: WORDED_SOURCE,
    language: 'ar',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('rejects a dropped count in an unreviewed locale-only plural form', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ar: "securityAgent\.dashboard\.daysOverdue_few" drops \{\{displayCount\}\} without a reviewed worded form/
  );
});

test('rejects a dropped count in a plural form the allowlist does not name', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ar: "securityAgent\.dashboard\.daysOverdue_other" placeholders differ from English \(displayCount\)/
  );
});

test('rejects a plural sibling that drops a value other than its count', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: "agents\.window_one" placeholders differ from English \(displayCount,start\)/
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

test('accepts the two lines wording one bucket apart', context => {
  const result = runChecker(context, {
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
  assert.equal(result.status, 0, result.stderr);
});

test('still rejects two unrelated families worded apart', context => {
  const english = {
    agents: {
      title: 'Agents',
      liveCount_one: '{{count}} live session',
      liveCount_other: '{{count}} live sessions',
      heldCount_one: '{{count}} live session',
      heldCount_other: '{{count}} live sessions',
    },
  };
  const result = runChecker(context, {
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
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /is translated 2 ways/);
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

test('accepts one spaced em dash in every agent-editor visibility option', context => {
  const result = runChecker(context, {
    english: AGENT_EDITOR,
    translated: AGENT_EDITOR_TRANSLATED,
    source: AGENT_EDITOR_SOURCE,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('rejects a visibility option whose label and description use a hyphen', context => {
  const result = runChecker(context, {
    english: AGENT_EDITOR,
    translated: {
      ...AGENT_EDITOR_TRANSLATED,
      profiles: {
        agents: { ...AGENT_EDITOR_TRANSLATED.profiles.agents, visibilityAll: 'Все - оба' },
      },
    },
    source: AGENT_EDITOR_SOURCE,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: "profiles\.agents\.visibilityAll" must join its label and description with " — "/
  );
});

test('rejects a catalog that translates the sampling parameter label', context => {
  const result = runChecker(context, {
    english: AGENT_EDITOR,
    translated: {
      ...AGENT_EDITOR_TRANSLATED,
      profiles: {
        agents: { ...AGENT_EDITOR_TRANSLATED.profiles.agents, topP: 'Верхний P' },
      },
    },
    source: AGENT_EDITOR_SOURCE,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /mobile\/ru: "profiles\.agents\.topP" must read "Top P" in every catalog/
  );
});

const PULL_REQUEST_TERM = {
  agents: { title: 'Agents' },
  manualReview: { startNotFound: 'Could not read that PR from GitHub.' },
};
const PULL_REQUEST_TERM_SOURCE = "t('agents.title');\nt('manualReview.startNotFound');";

test('accepts the pull-request term capitalized in a catalog', context => {
  const result = runChecker(context, {
    english: PULL_REQUEST_TERM,
    translated: {
      agents: { title: 'Агенты' },
      manualReview: { startNotFound: 'Не удалось прочитать этот PR из GitHub.' },
    },
    source: PULL_REQUEST_TERM_SOURCE,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

for (const [miscased, name] of [
  ['pR', 'the acronym with a lower-case first letter'],
  ['pull-Request', 'the hyphenated term with a lower-case first letter'],
]) {
  test(`rejects ${name}`, context => {
    const result = runChecker(context, {
      english: PULL_REQUEST_TERM,
      translated: {
        agents: { title: 'Агенты' },
        manualReview: { startNotFound: `Не удалось прочитать этот ${miscased} из GitHub.` },
      },
      source: PULL_REQUEST_TERM_SOURCE,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `mobile/ru: "manualReview\\.startNotFound" writes the pull-request term "${miscased}"; write "PR" or "Pull-Request"`
      )
    );
  });
}
