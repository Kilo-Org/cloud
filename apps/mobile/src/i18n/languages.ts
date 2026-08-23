/**
 * The 20 languages the mobile app supports. The list mirrors the push
 * notification catalog in `packages/notifications` so a token locale and a
 * channel name always resolve to the same tag.
 */
export const SUPPORTED_LANGUAGES = [
  'en',
  'es',
  'pt-BR',
  'fr',
  'de',
  'it',
  'nl',
  'pl',
  'ru',
  'uk',
  'tr',
  'ar',
  'he',
  'hi',
  'ja',
  'ko',
  'zh-Hans',
  'zh-Hant',
  'vi',
  'id',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Languages that lay out right-to-left. */
export const RTL_LANGUAGES = new Set<string>(['ar', 'he']);

/** Each language's name in its own language, for the picker rows. */
export const LANGUAGE_ENDONYMS: Record<SupportedLanguage, string> = {
  en: 'English',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  ru: 'Русский',
  uk: 'Українська',
  tr: 'Türkçe',
  ar: 'العربية',
  he: 'עברית',
  hi: 'हिन्दी',
  ja: '日本語',
  ko: '한국어',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia',
};

export function isSupportedLanguage(tag: string): tag is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(tag);
}
