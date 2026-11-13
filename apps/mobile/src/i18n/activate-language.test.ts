/* eslint-disable promise/prefer-await-to-callbacks -- the i18next backend contract hands its result to a callback, not a promise */
import {
  type BackendModule,
  createInstance,
  type i18n as I18nInstance,
  type ReadCallback,
  type ResourceKey,
} from 'i18next';
import { describe, expect, it } from 'vitest';

import { activateLanguage } from './activate-language';
import { CATALOG_LOADERS } from './catalogs';
import { isSupportedLanguage } from './languages';
import en from './locales/en.json';

type Harness = {
  readonly instance: I18nInstance;
  /** Every language tag the backend was asked for, in order. */
  readonly reads: readonly string[];
};

/**
 * A fresh instance mirroring `src/i18n/index.ts`: English bundled, one catalog
 * parsed per language on demand. The app singleton's backend is private to that
 * module, so the failing read this suite needs can only be injected into an
 * instance of its own — hence `activateLanguage`'s second parameter.
 *
 * A tag in `failingReads` fails its first read and would succeed on a retry,
 * which is exactly the state the app cannot leave: i18next remembers the failed
 * entry as `-1` and never asks again.
 */
function createHarness(failingReads: readonly string[] = []): Harness {
  const reads: string[] = [];
  const pendingFailures = new Set(failingReads);
  const backend: BackendModule = {
    type: 'backend',
    init: () => undefined,
    read: (language: string, _namespace: string, callback: ReadCallback) => {
      reads.push(language);
      if (pendingFailures.delete(language)) {
        callback(new Error(`catalog read failed: ${language}`), false);
        return;
      }
      if (!isSupportedLanguage(language)) {
        callback(new Error(`unsupported language: ${language}`), false);
        return;
      }
      callback(null, CATALOG_LOADERS[language]() as ResourceKey);
    },
  };
  const instance = createInstance();
  void instance.use(backend).init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    lng: 'en',
    fallbackLng: 'en',
    compatibilityJSON: 'v4',
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });
  return { instance, reads };
}

describe('activateLanguage', () => {
  it('recovers a catalog the backend failed once, and the copy is active', async () => {
    const { instance, reads } = createHarness(['pt-BR', 'pt']);

    await expect(activateLanguage('pt-BR', instance)).resolves.toBe('recovered');
    expect(instance.hasResourceBundle('pt-BR', 'translation')).toBe(true);
    expect(instance.t('consent.beforeWeGetStarted')).toBe('Antes de começarmos');
    // pt fails too, so the fallback chain cannot supply the copy, and the
    // failed entries are remembered: no tag is read twice, so the recovered
    // copy can only come from the direct catalog parse.
    expect(reads).toEqual(['pt-BR', 'pt']);

    await instance.changeLanguage('en');
  });

  it('reports a healthy load and reads one catalog per tag', async () => {
    const { instance, reads } = createHarness();

    await expect(activateLanguage('pt-BR', instance)).resolves.toBe('loaded');
    expect(instance.hasResourceBundle('pt-BR', 'translation')).toBe(true);
    expect(instance.t('consent.beforeWeGetStarted')).toBe('Antes de começarmos');
    // Only the requested tag and its base language: the bundled English
    // catalog is never re-read, and no recovery parse ran.
    expect(reads).toEqual(['pt-BR', 'pt']);

    await instance.changeLanguage('en');
  });
});
