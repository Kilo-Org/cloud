import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';
import en from './locales/en.json';

/**
 * A message that names a button must name it by key. `$t(key)` resolves in the
 * active language, so the message can never point at a control the user does
 * not see.
 */
const MESSAGE_KEYS = [
  'authErrors.emailAlreadyUsed',
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
