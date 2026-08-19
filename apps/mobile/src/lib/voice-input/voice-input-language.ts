import { getLocales } from 'expo-localization';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

/**
 * Resolve the BCP-47 language tag for voice recognition from the device's
 * locale list. The helper is defensive because runtime behavior can diverge
 * from the package's static typing: `getLocales()` may return an empty
 * array, or the first locale may be missing a tag, so every path falls back
 * to `en-US`. The parameter shape is intentionally structural so the caller
 * can pass `expo-localization`'s `Locale[]` without a type assertion.
 */
export function resolveVoiceInputLanguageTag(locales: readonly { languageTag?: string }[]): string {
  const first = locales[0];
  if (!first) {
    return 'en-US';
  }

  const tag = first.languageTag;
  if (!tag || tag.length === 0) {
    return 'en-US';
  }

  return tag;
}

function normalizeLocale(tag: string): string {
  return tag.toLowerCase().replaceAll('_', '-');
}

/**
 * Pick the best supported voice-input language tag from the device's
 * preferred-language list. Returns the matched tag in the spelling used by
 * the supported list, or `null` when no supported locale shares a language
 * with any device tag.
 *
 * Algorithm (deterministic; both sides normalized to lowercase with `_`→`-`):
 *
 * For each `deviceTag` in preference order:
 *   a. Exact normalized match in `supportedTags` → return it.
 *   b. Same-language fallback among `supportedTags` sharing the primary
 *      language subtag, with these tie-breaks in order:
 *        i.  Eponymous region: `<lang>-<LANG>` as a plain string rule
 *            (e.g. `de`→`de-DE`, `fr`→`fr-FR`).
 *        ii. `<lang>-US` if present.
 *        iii. Otherwise the first candidate in `supportedTags` order.
 *
 * No match for any device tag → `null`.
 */
export function pickSupportedVoiceInputLanguageTag(
  deviceTags: readonly string[],
  supportedTags: readonly string[]
): string | null {
  const normalized = supportedTags.map(tag => [normalizeLocale(tag), tag] as const);

  for (const rawDeviceTag of deviceTags) {
    if (rawDeviceTag) {
      const deviceTag = normalizeLocale(rawDeviceTag);

      // (a) Exact normalized match
      const exact = normalized.find(([n]) => n === deviceTag);
      if (exact) {
        return exact[1];
      }

      // (b) Same-language fallback
      const [deviceLang] = deviceTag.split('-');
      const sameLang = normalized.filter(([n]) => n.split('-')[0] === deviceLang);
      if (sameLang.length > 0) {
        // i. Eponymous region: <lang>-<LANG>
        const eponymous = sameLang.find(([n]) => n === `${deviceLang}-${deviceLang}`.toLowerCase());
        if (eponymous) {
          return eponymous[1];
        }

        // ii. <lang>-US
        const usVariant = sameLang.find(([n]) => n === `${deviceLang}-us`);
        if (usVariant) {
          return usVariant[1];
        }

        // iii. First candidate in supportedTags order
        const first = sameLang[0];
        if (first) {
          return first[1];
        }
      }
    }
  }

  return null;
}

let cachedSupportedTags: readonly string[] | null = null;

async function fetchSupportedLanguageTags(): Promise<readonly string[] | null> {
  if (cachedSupportedTags) {
    return cachedSupportedTags;
  }
  try {
    const result = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    cachedSupportedTags = result.locales;
    return cachedSupportedTags;
  } catch {
    return null;
  }
}

/**
 * Resolve the best language tag for voice recognition, preferring a match
 * against the recognizer's supported locales. On first call, fetches and
 * memoizes the supported list; failures are never cached so subsequent calls
 * retry. Falls back to the raw device preferred-language tag when the
 * supported list is empty, unavailable, or contains no same-language match.
 */
export async function resolveVoiceInputStartLanguageTag(): Promise<string> {
  const locales = getLocales();
  const deviceTags = locales
    .map(l => l.languageTag)
    // `getLocales()` types `languageTag` as a non-optional string, but the native
    // module can still hand back a missing/empty value at runtime.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- environment probe: guards against a real-device value diverging from expo-localization's static type.
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  const rawTag = resolveVoiceInputLanguageTag(locales);

  const supported = await fetchSupportedLanguageTags();
  if (!supported || supported.length === 0) {
    return rawTag;
  }

  return pickSupportedVoiceInputLanguageTag(deviceTags, supported) ?? rawTag;
}

/** Clear the session-level supported-locale cache. For tests only. */
export function __resetVoiceInputLanguageTagCacheForTests(): void {
  cachedSupportedTags = null;
}
