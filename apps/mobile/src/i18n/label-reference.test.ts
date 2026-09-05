import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';
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

describe('plural forms', () => {
  it('uses the translated Arabic singular and dual forms', async () => {
    await i18n.changeLanguage('ar');

    expect(i18n.t('agents.sessionRow.cent', { count: 1 })).toBe(ar.agents.sessionRow.cent_one);
    expect(i18n.t('agents.sessionRow.cent', { count: 2 })).toBe(ar.agents.sessionRow.cent_two);
  });
});
