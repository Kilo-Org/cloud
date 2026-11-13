import { type i18n as I18nInstance } from 'i18next';

import { i18n } from '@/i18n';
import { CATALOG_LOADERS } from '@/i18n/catalogs';
import { type SupportedLanguage } from '@/i18n/languages';
import { prewarmIntl } from '@/lib/intl-cache';

/** What the store held after the apply, not what the apply asked for. */
export type LanguageActivation = 'loaded' | 'recovered' | 'failed';

/**
 * Apply `language` and report whether its catalog is actually active.
 *
 * `changeLanguage` never rejects: the lazy backend hands its error to i18next,
 * which records the failed entry as `-1` and skips it on every later load — so
 * a failed read would otherwise leave the process in English for the whole
 * process, with no signal and no retry. The store is the check that matters,
 * and the one case i18next will not retry is loaded here directly.
 *
 * The second parameter is for tests, which need a backend that can fail;
 * production always uses the app's singleton.
 */
export async function activateLanguage(
  language: SupportedLanguage,
  instance: I18nInstance = i18n
): Promise<LanguageActivation> {
  // The plural-rules polyfill must be in place before the first render in the
  // new language. Warming it before the change is the order the root layout's
  // startup used, and it covers the recovery re-apply below too.
  prewarmIntl(language);

  try {
    await instance.changeLanguage(language);
    if (instance.hasResourceBundle(language, 'translation')) {
      return 'loaded';
    }
    // The failed read is remembered for the process, so re-selecting the
    // language never asks the backend again. Parse the catalog here and
    // re-apply: it is the second `changeLanguage` that settles
    // `resolvedLanguage` on the recovered bundle.
    instance.addResourceBundle(language, 'translation', CATALOG_LOADERS[language](), true, true);
    await instance.changeLanguage(language);
  } catch {
    return 'failed';
  }
  return instance.hasResourceBundle(language, 'translation') ? 'recovered' : 'failed';
}
