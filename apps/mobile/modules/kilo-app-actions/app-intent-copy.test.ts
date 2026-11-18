// The App Intent copy is bundle metadata, not app copy: the Shortcuts app
// labels the four intents, their parameters and the StartAgent failure from
// the `Localizable.strings` files `withAppIntentLocalizations` renders out of
// `plugins/app-intent-copy.json`. i18next never reads it, so every language
// the app supports must carry an entry here — an English-only file would ship
// English labels to a localized device, and the plugin throws per missing tag
// at prebuild so that can never happen quietly.

import { describe, expect, it } from 'vitest';

import APP_INTENT_COPY from '../../plugins/app-intent-copy.json';
import { INTENT_COPY_KEYS, renderLocalizableStrings } from '../../plugins/app-intent-copy.js';
import { RTL_LANGUAGES, SUPPORTED_LANGUAGES } from '../../src/i18n/languages';

/** The English entry: its keys are the contract, its values the `.strings` keys. */
const ENGLISH_COPY: Record<string, string> = APP_INTENT_COPY.en;

/** The whole file as tag → key → value. */
const COPY: Record<string, Record<string, string>> = APP_INTENT_COPY;

/** The tags that translate English rather than being English. */
const TRANSLATED_TAGS = SUPPORTED_LANGUAGES.filter(tag => tag !== 'en');

/**
 * `tag:key` pairs whose translation is legitimately identical to English:
 * "Prompt" is the term these languages use for an AI prompt, and the app's
 * own reviewed catalogs already carry it in sentences ("Dein Prompt geht
 * verloren"). Same escape hatch as ENGLISH_IDENTICAL_ALLOWLIST in
 * tools/i18n/check-catalogs.mjs — the guard stays meaningful because a tag
 * copied wholesale from `en` trips it nine times over.
 */
const ENGLISH_LOANWORD_ALLOWLIST = new Set([
  'de:promptParam',
  'fil:promptParam',
  'it:promptParam',
  'nl:promptParam',
  'pt-BR:promptParam',
  'sv:promptParam',
]);

/**
 * A sample for the renderer: `ar` and `he` are right-to-left (`he` joins the
 * RTL script with the Latin brand name), and `de`/`ja`/`zh-Hans`/`en` cover
 * the Latin and CJK scripts the `.strings` files carry.
 */
const SAMPLE_TAGS = ['en', 'de', 'ar', 'he', 'ja', 'zh-Hans'] as const;

describe('app-intent-copy', () => {
  it('holds an entry for every supported language and no tag beyond them', () => {
    expect(Object.keys(COPY).toSorted()).toEqual([...SUPPORTED_LANGUAGES].toSorted());
  });

  it('starts with English, the key language of the .strings files', () => {
    expect(Object.keys(COPY)[0]).toBe('en');
  });

  it.each(SUPPORTED_LANGUAGES)('gives %s exactly the English key set', tag => {
    const entry = COPY[tag];
    expect(entry, `${tag} has no entry`).toBeDefined();
    expect(Object.keys(entry ?? {}).toSorted()).toEqual(Object.keys(ENGLISH_COPY).toSorted());
  });

  it.each(TRANSLATED_TAGS)('%s carries no blank and no English-identical value', tag => {
    const entry = COPY[tag] ?? {};
    for (const key of INTENT_COPY_KEYS) {
      const value = entry[key] ?? '';
      expect(value.trim().length, `${tag}.${key} is blank`).toBeGreaterThan(0);
      const translated =
        value !== ENGLISH_COPY[key] || ENGLISH_LOANWORD_ALLOWLIST.has(`${tag}:${key}`);
      expect(translated, `${tag}.${key} still holds the English string`).toBe(true);
    }
  });
});

describe('renderLocalizableStrings over the real copy', () => {
  it('samples an RTL tag', () => {
    expect(RTL_LANGUAGES.has('ar'), 'ar is the RTL sample').toBe(true);
  });

  it.each(SAMPLE_TAGS)('renders one line per key for %s', tag => {
    const entry = COPY[tag] ?? {};
    const lines = renderLocalizableStrings(COPY, tag).split('\n');
    expect(lines.at(-1)).toBe('');
    const entries = lines.slice(0, -1);
    expect(entries).toHaveLength(INTENT_COPY_KEYS.length);
    for (const key of INTENT_COPY_KEYS) {
      expect(entries).toContain(`"${ENGLISH_COPY[key]}" = "${entry[key]}";`);
    }
  });

  it('escapes a quote and a backslash in a non-English value (de)', () => {
    // No real label carries `"` or `\`, so the escape path is proven on a
    // synthetic variant of the real `de` entry rather than a second `en` case.
    const copy = {
      ...COPY,
      de: {
        ...COPY.de,
        startFailedFallback: 'Der Agent „Test" konnte \\nicht starten.',
      },
    };
    expect(renderLocalizableStrings(copy, 'de')).toContain(
      String.raw`"Couldn't start the agent. Open Kilo and try again." = "Der Agent „Test\" konnte \\nicht starten.";`
    );
  });
});
