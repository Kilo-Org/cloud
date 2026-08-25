import { getLocales } from 'expo-localization';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

function normalizeLocale(tag: string): string {
  return tag.toLowerCase().replaceAll('_', '-');
}

function scriptSubtag(tag: string): string | undefined {
  return normalizeLocale(tag)
    .split('-')
    .slice(1)
    .find(part => part.length === 4);
}

const CHINESE_REGION_SCRIPTS = new Map([
  ['tw', 'hant'],
  ['hk', 'hant'],
  ['mo', 'hant'],
  ['cn', 'hans'],
  ['sg', 'hans'],
]);

/** Script of a tag. Chinese region tags imply a script, so map those too. */
function scriptOf(tag: string): string | undefined {
  const script = scriptSubtag(tag);
  if (script) {
    return script;
  }
  const parts = normalizeLocale(tag).split('-');
  if (parts[0] !== 'zh') {
    return undefined;
  }
  const region = parts.slice(1).find(part => part.length === 2);
  return region ? CHINESE_REGION_SCRIPTS.get(region) : undefined;
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
 *        i.  The same script subtag, when the device tag has one.
 *        ii. Eponymous region: `<lang>-<LANG>` as a plain string rule
 *            (e.g. `de`→`de-DE`, `fr`→`fr-FR`).
 *        iii. `<lang>-US` if present.
 *        iv. Otherwise the first candidate in `supportedTags` order.
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
        const deviceScript = scriptOf(deviceTag);
        const sameScript = deviceScript
          ? sameLang.find(([n]) => scriptOf(n) === deviceScript)
          : undefined;
        if (sameScript) {
          return sameScript[1];
        }

        // ii. Eponymous region: <lang>-<LANG>
        const eponymous = sameLang.find(([n]) => n === `${deviceLang}-${deviceLang}`.toLowerCase());
        if (eponymous) {
          return eponymous[1];
        }

        // iii. <lang>-US
        const usVariant = sameLang.find(([n]) => n === `${deviceLang}-us`);
        if (usVariant) {
          return usVariant[1];
        }

        // iv. First candidate in supportedTags order
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
 * Resolve the best language tag for voice recognition from the active app
 * language. On first call, fetches and
 * memoizes the supported list; failures are never cached so subsequent calls
 * retry. A matching device region refines the selected language. The selected
 * app language remains the fallback when the supported list is unavailable.
 */
export async function resolveVoiceInputStartLanguageTag(appLanguage: string): Promise<string> {
  const locales = getLocales();
  const deviceTags = locales
    .map(l => l.languageTag)
    // `getLocales()` types `languageTag` as a non-optional string, but the native
    // module can still hand back a missing/empty value at runtime.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- environment probe: guards against a real-device value diverging from expo-localization's static type.
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  const language = normalizeLocale(appLanguage).split('-')[0];
  const matchingDeviceTags = deviceTags.filter(
    tag => normalizeLocale(tag).split('-')[0] === language
  );
  const preferredTags = scriptOf(appLanguage)
    ? [appLanguage, ...matchingDeviceTags]
    : [...matchingDeviceTags, appLanguage];

  const supported = await fetchSupportedLanguageTags();
  if (!supported || supported.length === 0) {
    return appLanguage;
  }

  return pickSupportedVoiceInputLanguageTag(preferredTags, supported) ?? appLanguage;
}

/** Clear the session-level supported-locale cache. For tests only. */
export function __resetVoiceInputLanguageTagCacheForTests(): void {
  cachedSupportedTags = null;
}
