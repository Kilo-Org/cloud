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

function runChecker(context, { english = ENGLISH, translated = TRANSLATED, source = SOURCE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-catalogs-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const files = {
    'apps/mobile/src/i18n/languages.ts': "export const SUPPORTED_LANGUAGES = ['en', 'ru'];",
    'apps/mobile/src/example.ts': source,
    'apps/mobile/src/i18n/locales/en.json': JSON.stringify(english),
    'apps/mobile/src/i18n/locales/ru.json': JSON.stringify(translated),
    'packages/notifications/src/locales/en.json': '{}',
    'packages/notifications/src/locales/ru.json': '{}',
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

test('rejects an empty translated value', context => {
  const result = runChecker(context, {
    translated: { agents: { ...TRANSLATED.agents, title: '' } },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mobile\/ru: "agents\.title" is empty/);
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
