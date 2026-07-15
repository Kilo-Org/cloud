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
