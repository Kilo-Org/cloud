import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';
import ar from './locales/ar.json';
import en from './locales/en.json';
import sr from './locales/sr.json';

/**
 * A message that names a button must name it by key. `$t(key)` resolves in the
 * active language, so the message can never point at a control the user does
 * not see.
 */
const MESSAGE_KEYS = [
  'authErrors.differentOauth',
  'authErrors.ssoError',
  'authErrors.admissionRequired',
] as const;
const LABEL_KEY = 'login.moreSignInOptions';

/** The category a language's own rules assign, the same rules i18next uses. */
function category(tag: SupportedLanguage, count: number): string {
  return new Intl.PluralRules(tag).select(count);
}

const i18n = createInstance();
await i18n.init({
  resources: Object.fromEntries(
    SUPPORTED_LANGUAGES.map(tag => [tag, { translation: CATALOG_LOADERS[tag]() }])
  ),
  lng: 'en',
  fallbackLng: 'en',
  compatibilityJSON: 'v4',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

describe('label references', () => {
  it('names the sign-in sheet by key in English', () => {
    for (const key of MESSAGE_KEYS) {
      expect(en.authErrors[key.split('.')[1] as keyof typeof en.authErrors]).toContain(
        `$t(${LABEL_KEY})`
      );
    }
  });

  it.each(SUPPORTED_LANGUAGES)('resolves the label in %s', async tag => {
    await i18n.changeLanguage(tag);
    const label = i18n.t(LABEL_KEY);
    for (const key of MESSAGE_KEYS) {
      const message = i18n.t(key);
      expect(message).toContain(label);
      expect(message).not.toContain('$t(');
    }
  });
});

describe('catalog copy', () => {
  it.each(SUPPORTED_LANGUAGES)(
    'keeps concise, translated settings and empty-state copy in %s',
    async tag => {
      await i18n.changeLanguage(tag);
      const subtitle = i18n.t('preferences.biometricUnlockSubtitle');
      const empty = i18n.t('home.noLiveSessions');
      expect([
        ...new Intl.Segmenter(tag, { granularity: 'sentence' }).segment(subtitle),
      ]).toHaveLength(1);
      expect(subtitle.length).toBeLessThanOrEqual(160);
      if (tag !== 'en') {
        expect(subtitle).not.toBe(en.preferences.biometricUnlockSubtitle);
        expect(empty).not.toBe(en.home.noLiveSessions);
      }
    }
  );

  it('resolves the English and Serbian keys without fallback', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('preferences.biometricUnlockSubtitle')).toBe(
      'Unlock at launch and after five minutes in the background.'
    );
    expect(i18n.t('home.noLiveSessions')).toBe('Nothing running right now');
    await i18n.changeLanguage('sr');
    expect(i18n.t('preferences.biometricUnlockSubtitle')).toBe(
      sr.preferences.biometricUnlockSubtitle
    );
    expect(i18n.t('home.noLiveSessions')).toBe(sr.home.noLiveSessions);
    expect(sr.preferences.biometricUnlockSubtitle).toBe(
      'Otključavanje je obavezno pri pokretanju aplikacije i nakon pet minuta u pozadini.'
    );
    expect(sr.home.noLiveSessions).toBe('Trenutno ništa nije pokrenuto');
    expect(sr.home.noLiveSessions).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it.each(SUPPORTED_LANGUAGES)('keeps label case separate from fragment case in %s', async tag => {
    await i18n.changeLanguage(tag);
    if (tag === 'ka') {
      return;
    }
    for (const key of [
      'sessionRow.needsInput',
      'kiloclaw.dashboard.up',
      'kiloclaw.status.resources',
      'kiloclaw.status.running',
      'kiloclaw.status.starting',
      'kiloclaw.status.unknown',
    ] as const) {
      const value = i18n.t(key);
      expect(value, key).toBe(value.toLocaleUpperCase(tag));
    }
    for (const key of [
      'codeReviewer.reviewDetail.tokens',
      'codeReviewer.reviewDetail.transcriptLive',
      'codeReviewer.status.running',
      'agentChat.childSession.task',
      'chat.messageActions.edit',
      'securityAgent.dismiss.reasonNotUsed',
      'agentChat.collectCopyableText.errorPrefix',
    ] as const) {
      const value = i18n.t(key);
      expect(value, key).not.toMatch(/^\p{Ll}/u);
      if (/\p{Lu}/u.test(value)) {
        expect(value, key).toMatch(/\p{Ll}/u);
      }
    }
    if (tag === 'de') {
      return;
    }
    for (const key of [
      'agentChat.toolCard.toolEdit',
      'agentChat.toolCard.toolTask',
      'securityAgent.findingDetails.reasonFixStarted',
      'securityAgent.findingDetails.reasonNoBandwidth',
      'securityAgent.findingDetails.reasonTolerableRisk',
      'securityAgent.findingDetails.reasonInaccurate',
      'securityAgent.findingDetails.reasonNotUsed',
      'securityAgent.findingDetails.reasonAfterReview',
    ] as const) {
      expect(i18n.t(key), key).not.toMatch(/^\p{Lu}/u);
    }
  });
});

describe('PR-comment copy', () => {
  const COMMENT_KEYS = [
    'prReview.discussion.addCommentCta',
    'prReview.discussion.commentBadRequest',
    'prReview.discussion.commentForbidden',
    'prReview.discussion.fixWithKilo',
  ] as const;
  const FIX_WITH_KILO_PROMPT = 'prReview.discussion.fixWithKiloPrompt';
  const COMMENT_LINK = 'https://example.com/x';

  /**
   * The string a catalog itself ships for a dotted key, or undefined when the
   * catalog does not carry it yet. i18next falls back to English for a missing
   * key, and catalog parity is the translation slice's job, so the
   * `not.toBe(english)` assertions below fire once a catalog carries the key:
   * until then the value IS the English string because of the fallback.
   */
  function catalogValue(tag: SupportedLanguage, key: string): string | undefined {
    let node: unknown = CATALOG_LOADERS[tag]();
    for (const part of key.split('.')) {
      if (typeof node !== 'object' || node === null) {
        return undefined;
      }
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : undefined;
  }

  it('defines the English source strings', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t(COMMENT_KEYS[0])).toBe('Comment on this pull request');
    expect(i18n.t(COMMENT_KEYS[1])).toBe(
      "This comment can't be posted. The pull request may have changed."
    );
    expect(i18n.t(COMMENT_KEYS[2])).toBe(
      "You don't have permission to comment on this pull request."
    );
    expect(i18n.t(COMMENT_KEYS[3])).toBe('Fix with Kilo');
    expect(i18n.t(FIX_WITH_KILO_PROMPT, { link: COMMENT_LINK })).toBe(
      `Please address the following PR comment: ${COMMENT_LINK}`
    );
  });

  it.each(SUPPORTED_LANGUAGES)('ships translated PR-comment copy in %s', async tag => {
    await i18n.changeLanguage(tag);
    for (const key of COMMENT_KEYS) {
      const value = i18n.t(key);
      const english = i18n.t(key, { lng: 'en' });
      expect(value, `${tag} ${key}`).toBeTruthy();
      expect(value, `${tag} ${key}`).not.toContain('{{');
      // A catalog without the key falls back to the English string here.
      if (tag !== 'en' && catalogValue(tag, key) !== undefined) {
        expect(value, `${tag} ${key}`).not.toBe(english);
      }
    }
  });

  it.each(SUPPORTED_LANGUAGES)(
    'addresses the comment by link in the composer message in %s',
    async tag => {
      await i18n.changeLanguage(tag);
      const message = i18n.t(FIX_WITH_KILO_PROMPT, { link: COMMENT_LINK });
      expect(message, tag).toContain(COMMENT_LINK);
      expect(message, tag).not.toContain('{{');
      const own = catalogValue(tag, FIX_WITH_KILO_PROMPT);
      if (tag !== 'en' && own !== undefined) {
        expect(own, tag).not.toBe(en.prReview.discussion.fixWithKiloPrompt);
        expect(message, tag).not.toBe(
          i18n.t(FIX_WITH_KILO_PROMPT, { link: COMMENT_LINK, lng: 'en' })
        );
      }
    }
  );
});

describe('plural forms', () => {
  it('uses the translated Arabic singular and dual forms', async () => {
    await i18n.changeLanguage('ar');

    expect(i18n.t('agents.sessionRow.cent', { count: 1 })).toBe(ar.agents.sessionRow.cent_one);
    expect(i18n.t('agents.sessionRow.cent', { count: 2 })).toBe(ar.agents.sessionRow.cent_two);
  });

  /**
   * The owner's counted rows, asserted on the side this slice owns: English
   * declares the plural family and every call site hands i18next its count.
   * The count forms the other catalogs need — Serbian, Russian and Polish
   * included — are the translation slice's output and its acceptance, because
   * copy is edited in `locales/en.json` only (apps/mobile/AGENTS.md,
   * Translations).
   *
   * `exactUsedKey` proves which category i18next picked, and the expected
   * string is read back out of the loaded catalog, so the test never restates
   * a translation.
   */
  const COUNTED_KEYS = [
    'agentChat.toolRun.condensedLabel',
    'securityAgent.dashboard.daysOverdue',
    'prReview.checks.checksCount',
  ] as const;
  const COUNTS = [1, 2, 5, 21] as const;
  /** The languages the defect report named: "1 stavki" and "2 stavki". */
  const REPORTED_LANGUAGES = ['sr', 'ru', 'pl'] as const;
  /**
   * The two families whose counted noun itself changes form. The checks count
   * is a head-noun construction ("broj provera: N") in the reported languages,
   * invariant at every count like the Slovenian findings count, so it keeps
   * only the read-back assertion.
   */
  const INFLECTING_KEYS = [
    'agentChat.toolRun.condensedLabel',
    'securityAgent.dashboard.daysOverdue',
  ] as const;

  function render(language: SupportedLanguage, key: string, count: number) {
    return i18n.t(key, {
      lng: language,
      count,
      itemCount: String(count),
      displayCount: String(count),
      last: 'Read',
      returnDetails: true,
    }) as unknown as { res: string; exactUsedKey: string };
  }

  /**
   * A catalog's own template for `key`, with the row's values in place — the
   * expected string comes from the catalog, never from this test.
   */
  function catalogForm(language: SupportedLanguage, key: string, count: number): string {
    const value = i18n.getResource(language, 'translation', key);
    if (typeof value !== 'string') {
      throw new TypeError(`${language} declares no ${key}`);
    }
    return value
      .replaceAll('{{itemCount}}', String(count))
      .replaceAll('{{displayCount}}', String(count))
      .replaceAll('{{last}}', 'Read');
  }

  it.each(COUNTED_KEYS)('selects the English count form for %s', key => {
    for (const count of COUNTS) {
      const details = render('en', key, count);
      const expected = `${key}_${category('en', count)}`;
      expect(details.exactUsedKey, `${key} ${count}`).toBe(expected);
      expect(details.res, `${key} ${count}`).toBe(catalogForm('en', expected, count));
    }
  });

  it.each(COUNTED_KEYS)('renders a different row at 1 and at 5 for %s', key => {
    // The count itself interpolates into the row, so mask it before
    // comparing: the defect was one form for every count, and the two
    // unmasked rows differ by the number alone.
    const form = (count: number) => render('en', key, count).res.replace(String(count), '');
    expect(form(1), key).not.toBe(form(5));
  });

  /**
   * The defect report's own languages, on the side the catalogs own: at count
   * 1 the family must select `_one`; "1 stavki" was the `_other` form rendered
   * for every count. `exactUsedKey` proves which category i18next picked and
   * the expected string is read back out of that language's catalog, so the
   * test never restates a translation.
   */
  it.each(COUNTED_KEYS)(
    'selects the Serbian, Russian and Polish count form at 1, 2, 5 and 21 for %s',
    key => {
      for (const language of REPORTED_LANGUAGES) {
        for (const count of COUNTS) {
          const details = render(language, key, count);
          const usedKey = `${key}_${category(language, count)}`;
          expect(details.exactUsedKey, `${language} ${key} ${count}`).toBe(usedKey);
          expect(details.res, `${language} ${key} ${count}`).toBe(
            catalogForm(language, usedKey, count)
          );
        }
      }
    }
  );

  it.each(INFLECTING_KEYS)(
    'inflects the Serbian, Russian and Polish row at 1 and at 2 for %s',
    key => {
      // The count itself interpolates into the row, so mask it before
      // comparing: the owner's "1 stavka" must differ from "2 stavke".
      for (const language of REPORTED_LANGUAGES) {
        const form = (count: number) => render(language, key, count).res.replace(String(count), '');
        expect(form(1), `${language} ${key}`).not.toBe(form(2));
      }
    }
  );

  /**
   * Every catalog is checked at 1, 2, 5 and 21, not only the three the defect
   * report named: i18next must select the language's own category and the row
   * must equal that catalog's own form for it.
   */
  it.each(SUPPORTED_LANGUAGES)(
    'selects the count form its catalog declares in %s at 1, 2, 5 and 21',
    language => {
      for (const key of COUNTED_KEYS) {
        for (const count of COUNTS) {
          const details = render(language, key, count);
          const usedKey = `${key}_${category(language, count)}`;
          expect(details.exactUsedKey, `${language} ${key} ${count}`).toBe(usedKey);
          expect(details.res, `${language} ${key} ${count}`).toBe(
            catalogForm(language, usedKey, count)
          );
        }
      }
    }
  );

  /**
   * The review caught the Slovenian findings count: the head "Število" (the
   * number) governs the phrase, so the genitive plural "ugotovitev" cannot
   * inflect with the count. A per-category form rendered "Število ugotovitve:
   * 3" and "Število ugotovitvi: 2"; one wording must hold at every count.
   */
  it('holds the Slovenian findings count invariant', async () => {
    await i18n.changeLanguage('sl');
    const rows = [1, 2, 3, 4, 5, 21].map(count =>
      i18n.t('securityAgent.dashboard.findingsCount', { count, displayCount: 'N' })
    );
    expect(new Set(rows).size).toBe(1);
    expect(rows[0]).toBe('Število ugotovitev: N');
  });
});
