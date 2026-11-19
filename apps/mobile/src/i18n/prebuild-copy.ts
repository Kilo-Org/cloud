import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages.ts';

/**
 * The value `copy[key]` holds, or a thrown error when it is missing or blank.
 * The prebuild-copy builders share this so a prebuild fails loudly instead of
 * shipping an English native string on a localized device.
 */
// eslint-disable-next-line max-params -- the copy, the language tag, the key and the label its error names
export function readNonEmptyCopy<TKey extends string>(
  copy: Partial<Record<TKey, string>>,
  tag: string,
  key: TKey,
  label: string
): string {
  const value = copy[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing or empty ${label} copy for ${tag}.${key}`);
  }
  return value;
}

/**
 * One built entry per supported language, or a thrown error naming the first
 * language the copy lacks.
 */
export function buildCopyByLanguage<TEntry, TValue>(
  copy: Record<string, TEntry | undefined>,
  label: string,
  build: (entry: TEntry, tag: SupportedLanguage) => TValue
): Record<SupportedLanguage, TValue> {
  const entries: [SupportedLanguage, TValue][] = [];
  for (const tag of SUPPORTED_LANGUAGES) {
    const entry = copy[tag];
    if (!entry) {
      throw new Error(`Missing ${label} copy for language: ${tag}`);
    }
    entries.push([tag, build(entry, tag)]);
  }
  return Object.fromEntries(entries) as Record<SupportedLanguage, TValue>;
}
