import i18next from 'i18next';

import ar from './locales/ar.json';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import he from './locales/he.json';
import hi from './locales/hi.json';
import id from './locales/id.json';
import it from './locales/it.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import nl from './locales/nl.json';
import pl from './locales/pl.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import tr from './locales/tr.json';
import uk from './locales/uk.json';
import vi from './locales/vi.json';
import zhHans from './locales/zh-Hans.json';
import zhHant from './locales/zh-Hant.json';

const resources = {
  en: { translation: en },
  es: { translation: es },
  'pt-BR': { translation: ptBR },
  fr: { translation: fr },
  de: { translation: de },
  it: { translation: it },
  nl: { translation: nl },
  pl: { translation: pl },
  ru: { translation: ru },
  uk: { translation: uk },
  tr: { translation: tr },
  ar: { translation: ar },
  he: { translation: he },
  hi: { translation: hi },
  ja: { translation: ja },
  ko: { translation: ko },
  'zh-Hans': { translation: zhHans },
  'zh-Hant': { translation: zhHant },
  vi: { translation: vi },
  id: { translation: id },
};

const i18n = i18next.createInstance();
void i18n.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

/**
 * Resolve a stored token locale to a catalog tag. Null and unsupported tags
 * fall back to English; a token with no locale is treated as English.
 */
export function resolvePushLocale(locale: string | null | undefined): string {
  if (locale != null && locale in resources) return locale;
  return 'en';
}

/**
 * Translate a catalog key for a push locale. Unknown locales use English.
 * An unknown key returns `fallback` when provided; otherwise it returns the
 * key itself (test-only convenience — production callers pass a fallback).
 */
export function translatePush(
  locale: string | null | undefined,
  key: string,
  params?: Record<string, string>,
  fallback?: string
): string {
  const lng = resolvePushLocale(locale);
  return i18n.t(key, { ...params, lng, defaultValue: fallback ?? key });
}
