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
  ] as const;

  it('defines the English source strings', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t(COMMENT_KEYS[0])).toBe('Comment on this pull request');
    expect(i18n.t(COMMENT_KEYS[1])).toBe(
      "This comment can't be posted. The pull request may have changed."
    );
    expect(i18n.t(COMMENT_KEYS[2])).toBe(
      "You don't have permission to comment on this pull request."
    );
  });

  it.each(SUPPORTED_LANGUAGES)('ships translated PR-comment copy in %s', async tag => {
    await i18n.changeLanguage(tag);
    for (const key of COMMENT_KEYS) {
      const value = i18n.t(key);
      const english = i18n.t(key, { lng: 'en' });
      expect(value, `${tag} ${key}`).toBeTruthy();
      expect(value, `${tag} ${key}`).not.toContain('{{');
      if (tag !== 'en') {
        // A catalog without the key falls back to the English string here.
        expect(value, `${tag} ${key}`).not.toBe(english);
      }
    }
  });
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

  function render(key: string, count: number) {
    return i18n.t(key, {
      lng: 'en',
      count,
      itemCount: String(count),
      displayCount: String(count),
      last: 'Read',
      returnDetails: true,
    }) as unknown as { res: string; exactUsedKey: string };
  }

  /**
   * The English catalog's own template for `key`, with the row's values in
   * place — the expected string comes from the catalog, never from this test.
   */
  function catalogForm(key: string, count: number): string {
    const value = i18n.getResource('en', 'translation', key);
    if (typeof value !== 'string') {
      throw new TypeError(`en declares no ${key}`);
    }
    return value
      .replaceAll('{{itemCount}}', String(count))
      .replaceAll('{{displayCount}}', String(count))
      .replaceAll('{{last}}', 'Read');
  }

  it.each(COUNTED_KEYS)('selects the English count form for %s', key => {
    for (const count of COUNTS) {
      const details = render(key, count);
      const expected = `${key}_${category('en', count)}`;
      expect(details.exactUsedKey, `${key} ${count}`).toBe(expected);
      expect(details.res, `${key} ${count}`).toBe(catalogForm(expected, count));
    }
  });

  it.each(COUNTED_KEYS)('renders a different row at 1 and at 5 for %s', key => {
    // The count itself interpolates into the row, so mask it before
    // comparing: the defect was one form for every count, and the two
    // unmasked rows differ by the number alone.
    const form = (count: number) => render(key, count).res.replace(String(count), '');
    expect(form(1), key).not.toBe(form(5));
  });

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
