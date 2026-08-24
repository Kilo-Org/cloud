import { type BackendModule, createInstance, type ReadCallback } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { CATALOG_LOADERS } from './catalogs';
import { isSupportedLanguage } from './languages';
import en from './locales/en.json';

/**
 * Loads one catalog on demand. English is bundled into the instance below, so
 * a cold start parses one catalog; every other language is parsed the first
 * time the user selects it. `require` is synchronous in Metro, so the callback
 * fires in the same tick and `changeLanguage` still resolves immediately.
 */
const lazyCatalogBackend: BackendModule = {
  type: 'backend',
  init: () => undefined,
  // i18next's backend contract is a callback, not a promise. `require` is
  // synchronous in Metro, so the callback fires in the same tick and
  // `changeLanguage` still resolves before the next paint.
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    if (!isSupportedLanguage(language)) {
      callback(new Error(`unsupported language: ${language}`), false);
      return;
    }
    try {
      callback(null, CATALOG_LOADERS[language]());
    } catch (error) {
      callback(error as Error, false);
    }
  },
};

export const i18n = createInstance();

void i18n
  .use(lazyCatalogBackend)
  .use(initReactI18next)
  .init({
    // English only: the fallback must never wait on a load.
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    lng: 'en',
    fallbackLng: 'en',
    compatibilityJSON: 'v4',
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });
