import { getLocales } from 'expo-localization';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import { LANGUAGE_ENDONYMS, LANGUAGE_ENGLISH_NAMES, SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { resolveSupportedLanguageTag } from '@/i18n/resolve-language';

function normalizeLocale(tag: string): string {
  return tag.toLowerCase().replaceAll('_', '-');
}

function scriptSubtag(tag: string): string | undefined {
  return normalizeLocale(tag)
    .split('-')
    .slice(1)
    .find(part => part.length === 4);
}

// Region-implied script, keyed `<language>-<region>`. Chinese is handled by
// its own rule below, which needs no region list.
const REGION_SCRIPTS = new Map([
  ['sr-rs', 'cyrl'],
  ['sr-ba', 'cyrl'],
  ['sr-me', 'cyrl'],
  ['sr-xk', 'cyrl'],
  ['pa-pk', 'arab'],
  ['pa-in', 'guru'],
  ['az-ir', 'arab'],
  ['az-az', 'latn'],
  ['uz-af', 'arab'],
  ['uz-uz', 'latn'],
]);

/** Script of a tag. When the tag lacks a script subtag, a region implies one. */
function scriptOf(tag: string): string | undefined {
  const script = scriptSubtag(tag);
  if (script) {
    return script;
  }
  const parts = normalizeLocale(tag).split('-');
  const [language] = parts;
  if (language === 'zh') {
    const traditional = parts
      .slice(1)
      .some(subtag => subtag === 'hant' || subtag === 'tw' || subtag === 'hk' || subtag === 'mo');
    return traditional ? 'hant' : 'hans';
  }
  const region = parts.slice(1).find(part => part.length === 2);
  return region ? REGION_SCRIPTS.get(`${language}-${region}`) : undefined;
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

/**
 * Map a stored voice-input language tag onto the option list of the mode that
 * is in effect now. A choice is stored as one tag, but gateway mode offers the
 * app's languages (`de`) while device mode offers the OS locales (`de-DE`), so
 * a tag saved in the other mode matches no row: the picker shows nothing
 * checked and the tag cannot reach the recogniser unchanged. An exact match
 * wins (case/`_`-insensitive), then the same-language fallback inside
 * `pickSupportedVoiceInputLanguageTag`; `null` — the Automatic row — means no
 * option shares the stored tag's language.
 */
export function reconcileVoiceInputLanguageTag(
  storedTag: string | null,
  optionTags: readonly string[]
): string | null {
  if (storedTag === null) {
    return null;
  }
  return pickSupportedVoiceInputLanguageTag([storedTag], optionTags);
}

let cachedVoiceRecognitionLocales: {
  locales: readonly string[];
  installedLocales: readonly string[];
} | null = null;

async function fetchVoiceRecognitionLocales(): Promise<{
  locales: readonly string[];
  installedLocales: readonly string[];
} | null> {
  if (cachedVoiceRecognitionLocales) {
    return cachedVoiceRecognitionLocales;
  }
  try {
    const result = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    cachedVoiceRecognitionLocales = {
      locales: result.locales,
      installedLocales: result.installedLocales,
    };
    return cachedVoiceRecognitionLocales;
  } catch {
    return null;
  }
}

/**
 * The recognition service's supported and installed locale lists, memoized for
 * the session by `fetchVoiceRecognitionLocales`. `null` means the service call
 * failed (never cached, so a later call retries); a successful call that
 * reports zero locales is a real "no languages" answer, not an error.
 */
export async function getVoiceRecognitionLocales(): Promise<{
  locales: readonly string[];
  installedLocales: readonly string[];
} | null> {
  const result = await fetchVoiceRecognitionLocales();
  return result;
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

  const supported = await fetchVoiceRecognitionLocales();
  if (!supported || supported.locales.length === 0) {
    return appLanguage;
  }

  return pickSupportedVoiceInputLanguageTag(preferredTags, supported.locales) ?? appLanguage;
}

/**
 * Resolve the tag a session actually starts with. A persisted tag wins only
 * when it maps onto the active mode's list (`reconcileVoiceInputLanguageTag`);
 * otherwise the app/device language is resolved fresh. This is what keeps a
 * tag chosen in the other mode — a gateway `zh-Hans` used in device mode —
 * from reaching the recogniser and failing with `language-not-supported`.
 * Gateway mode reconciles against the static app list, so it never fetches the
 * device's locales. A failed or empty device answer is no evidence the stored
 * tag is wrong, so device mode keeps it rather than discarding an explicit
 * choice on a probe that returned nothing.
 */
export async function resolveVoiceInputSessionLanguageTag(
  storedTag: string | null,
  mode: 'device' | 'gateway',
  appLanguage: string
): Promise<string> {
  if (storedTag === null) {
    return resolveVoiceInputStartLanguageTag(appLanguage);
  }

  // Gateway mode never fetches the device's locales: it reconciles against the
  // static app list only.
  const deviceLocales = mode === 'device' ? await getVoiceRecognitionLocales() : null;
  // A failed or empty device answer cannot prove the tag wrong, so it wins:
  // discarding an explicit choice on a probe that returned nothing would
  // silently drop the user's selection.
  if (mode === 'device' && (deviceLocales === null || deviceLocales.locales.length === 0)) {
    return storedTag;
  }

  const optionTags = deviceLocales === null ? SUPPORTED_LANGUAGES : deviceLocales.locales;
  const reconciled = reconcileVoiceInputLanguageTag(storedTag, optionTags);
  return reconciled ?? resolveVoiceInputStartLanguageTag(appLanguage);
}

/**
 * Whether the recognition service reports the language as installed for
 * offline (on-device) recognition. Starting with
 * `requiresOnDeviceRecognition` for a language that is only supported online
 * fails on every attempt (`language-not-supported`) — that is the bug where
 * voice input broke on devices whose locale has no offline speech model. The
 * gate therefore returns `false` only for the positively-known-bad case
 * ("supported but not installed"); when the service exposes no per-language
 * data at all (older Android versions, non-Google service packages) it keeps
 * the previous on-device behavior rather than blocking a start that may work.
 */
export async function isVoiceInputLanguageInstalledOnDevice(languageTag: string): Promise<boolean> {
  const data = await fetchVoiceRecognitionLocales();
  if (!data || pickSupportedVoiceInputLanguageTag([languageTag], data.locales) === null) {
    return true;
  }
  return pickSupportedVoiceInputLanguageTag([languageTag], data.installedLocales) !== null;
}

/**
 * Name a recognition language the way the language picker does — by its
 * endonym (`de-DE` → "Deutsch") — so feedback about missing speech models
 * reads like the rest of the app. The picker's resolver matches the whole
 * tag first, so `pt-BR` names the Brazilian variant rather than Portugal,
 * and maps `zh-CN`/`zh-TW` onto the Simplified/Traditional scripts the app
 * ships. Falls back to the raw tag for a language the app does not ship.
 */
export function voiceInputLanguageDisplayName(languageTag: string): string {
  const language = resolveSupportedLanguageTag([{ languageTag }]);
  return language ? LANGUAGE_ENDONYMS[language] : languageTag;
}

/**
 * The English name of a recognition language, so the picker's search matches
 * the name a user is likelier to know than the endonym or the raw tag
 * (`de-DE` → "German"). Mirrors `voiceInputLanguageDisplayName`: resolves the
 * whole tag first, and returns `undefined` for a language the app does not
 * ship so callers add no match term rather than the raw tag twice.
 */
export function voiceInputLanguageEnglishName(languageTag: string): string | undefined {
  const language = resolveSupportedLanguageTag([{ languageTag }]);
  return language ? LANGUAGE_ENGLISH_NAMES[language] : undefined;
}

/**
 * Drop the memoized supported/installed locale lists so the next gate
 * re-queries the service. The download flow calls this after triggering a
 * model download: without it a successful download would stay invisible to
 * the gate for the rest of the session.
 */
export function invalidateVoiceRecognitionLocalesCache(): void {
  cachedVoiceRecognitionLocales = null;
}

/** Clear the session-level supported-locale cache. For tests only. */
export function __resetVoiceInputLanguageTagCacheForTests(): void {
  invalidateVoiceRecognitionLocalesCache();
}
