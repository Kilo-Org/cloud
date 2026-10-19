import { getLocales } from 'expo-localization';

import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

function normalizeLocale(tag: string): string {
  // Android's speech service names Mandarin with the ISO 639-3 code `cmn`
  // (`cmn-Hans-CN`), the app ships it as `zh-Hans`/`zh-Hant`. Canonicalizing
  // the primary subtag here makes every comparison below treat the two
  // spellings as one language.
  return tag
    .toLowerCase()
    .replaceAll('_', '-')
    .replace(/^cmn(?=-|$)/, 'zh');
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
 * Portuguese variant resolution. iOS reports a pt-BR device as the bare tag
 * `pt` with the region in `regionCode`, not in `languageTag`, and regionless
 * or region-mismatched tags (`pt-US`) carry no variant either. Everything
 * Portuguese resolves to the Brazilian variant unless the tag names a
 * European-Portuguese region: `pt-PT` (in any subtag order, so `pt-Latn-PT`
 * counts), the other regions whose norms follow the Portugal catalogue
 * (`pt-AO`, `pt-MZ`, `pt-CV`, `pt-GW`, `pt-ST`, `pt-TL`, `pt-MO`), or bare
 * `pt` with one of those regions in `regionCode`. Runs before the
 * exact-match branch, which a bare `pt` would otherwise win against the
 * Portugal entry. `tag` arrives lowercased from `normalizeLocale`, so the
 * region comparisons use lowercase.
 */
/** Regions whose Portuguese norms follow the Portugal catalogue. */
const IS_EUROPEAN_PORTUGUESE_REGION = {
  pt: true,
  ao: true,
  mz: true,
  cv: true,
  gw: true,
  st: true,
  tl: true,
  mo: true,
} satisfies Record<string, true>;

function portugueseVariantFor(
  tag: string,
  regionCode: string | null | undefined
): SupportedLanguage | undefined {
  if (tag.split('-')[0] !== 'pt') {
    return undefined;
  }
  // The region subtag, whatever position it sits in (`pt-PT`, `pt-Latn-PT`).
  const tagRegion = tag
    .split('-')
    .slice(1)
    .find(part => part.length === 2);
  const region = tagRegion ?? regionCode?.toLowerCase() ?? null;
  if (region !== null && region in IS_EUROPEAN_PORTUGUESE_REGION) {
    return 'pt';
  }
  return 'pt-BR';
}

/**
 * Resolve the supported language for a locale list. For each tag in
 * preference order, map Chinese scripts, map Portuguese variants, then exact
 * match, then same-language fallback. Returns `null` when no tag matches a
 * supported language, so callers can apply their own fallback.
 */
export function resolveSupportedLanguageTag(
  locales: readonly { languageTag?: string; regionCode?: string | null }[]
): SupportedLanguage | null {
  for (const locale of locales) {
    const raw = locale.languageTag;
    if (raw && raw.length > 0) {
      const tag = normalizeLocale(raw);

      const script = chineseScriptFor(tag);
      if (script) {
        return script;
      }

      const variant = portugueseVariantFor(tag, locale.regionCode);
      if (variant) {
        return variant;
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
  return null;
}

/**
 * Resolve the supported language for a device locale list. For each device
 * tag in preference order, map Chinese scripts, map Portuguese variants, then
 * exact match, then same-language fallback. An empty list or no match resolves
 * to `en`.
 */
export function resolveLanguageTag(
  locales: readonly { languageTag?: string; regionCode?: string | null }[]
): SupportedLanguage {
  return resolveSupportedLanguageTag(locales) ?? 'en';
}

/** Resolve the supported language from the device's preferred locale list. */
export function resolveDeviceLanguage(): SupportedLanguage {
  return resolveLanguageTag(getLocales());
}
