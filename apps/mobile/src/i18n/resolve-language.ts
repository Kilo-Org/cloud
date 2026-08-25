import { getLocales } from 'expo-localization';

import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

function normalizeLocale(tag: string): string {
  return tag.toLowerCase().replaceAll('_', '-');
}

/**
 * Chinese script resolution. Script-bearing tags such as `zh-Hant-TW` do
 * occur on iOS and Android, so read the subtags, not the full tag. Any `zh`
 * tag whose subtags contain `hant`, `tw`, `hk`, or `mo` resolves to
 * Traditional; every other `zh*` tag resolves to Simplified.
 */
function chineseScriptFor(tag: string): SupportedLanguage | undefined {
  const subtags = tag.split('-');
  if (subtags[0] !== 'zh') {
    return undefined;
  }
  const traditional = subtags.some(
    subtag => subtag === 'hant' || subtag === 'tw' || subtag === 'hk' || subtag === 'mo'
  );
  return traditional ? 'zh-Hant' : 'zh-Hans';
}

/**
 * Resolve the supported language for a device locale list. Mirrors
 * `resolveVoiceInputLanguageTag`: for each device tag in preference order,
 * map Chinese scripts, then exact match, then same-language fallback. An
 * empty list or no match resolves to `en`.
 */
export function resolveLanguageTag(
  locales: readonly { languageTag?: string }[]
): SupportedLanguage {
  for (const locale of locales) {
    const raw = locale.languageTag;
    if (raw && raw.length > 0) {
      const tag = normalizeLocale(raw);

      const script = chineseScriptFor(tag);
      if (script) {
        return script;
      }

      const exact = SUPPORTED_LANGUAGES.find(supported => normalizeLocale(supported) === tag);
      if (exact) {
        return exact;
      }

      const [language] = tag.split('-');
      const sameLanguage = SUPPORTED_LANGUAGES.find(
        supported => normalizeLocale(supported).split('-')[0] === language
      );
      if (sameLanguage) {
        return sameLanguage;
      }
    }
  }
  return 'en';
}

/** Resolve the supported language from the device's preferred locale list. */
export function resolveDeviceLanguage(): SupportedLanguage {
  return resolveLanguageTag(getLocales());
}
