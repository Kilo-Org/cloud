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
  } catch {
    // A `languageChanged` listener can throw through `changeLanguage` after
    // i18next has already stored the bundle and set the language: the iOS
    // glanceable refreshes re-register WidgetKit and ActivityKit surfaces
    // synchronously inside the emit, and those host functions throw. The
    // store decides, not the rejection — reporting `failed` there would send
    // the startup path to its English fallback with Arabic already applied,
    // which is a mirrored English UI for the whole process.
    return isActive(instance, language) ? 'loaded' : 'failed';
  }
  if (!instance.hasResourceBundle(language, 'translation')) {
    // The failed read is remembered for the process, so re-selecting the
    // language never asks the backend again. Parse the catalog here and
    // re-apply: it is the second `changeLanguage` that settles
    // `resolvedLanguage` on the recovered bundle.
    try {
      instance.addResourceBundle(language, 'translation', CATALOG_LOADERS[language](), true, true);
      await instance.changeLanguage(language);
    } catch {
      // Same listener-throw case as above, now with the parsed bundle in the
      // store: the re-apply that settles `resolvedLanguage` may be the call
      // that threw, so the store still decides.
      return isActive(instance, language) ? 'recovered' : 'failed';
    }
    return isActive(instance, language) ? 'recovered' : 'failed';
  }
  return 'loaded';
}

/** Whether the store holds `language` and the instance runs it. */
function isActive(instance: I18nInstance, language: SupportedLanguage): boolean {
  return instance.language === language && instance.hasResourceBundle(language, 'translation');
}
