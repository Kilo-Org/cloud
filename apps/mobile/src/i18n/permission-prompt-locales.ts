import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages.ts';

/**
 * The five Info.plist usage descriptions iOS can draw for this app. Expo's
 * `withLocales` plugin writes one `<tag>.lproj/InfoPlist.strings` per language
 * from the config's top-level `locales` field; these are the keys it must hold.
 */
export const PERMISSION_PROMPT_PLIST_KEYS = [
  'NSMicrophoneUsageDescription',
  'NSSpeechRecognitionUsageDescription',
  'NSFaceIDUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSUserTrackingUsageDescription',
] as const;

type PermissionPlistKey = (typeof PERMISSION_PROMPT_PLIST_KEYS)[number];

/** Prebuild-time copy, one entry per language tag. */
export type PermissionPromptCopy = Record<string, Partial<Record<PermissionPlistKey, string>>>;

/** The prebuild-time copy for one language, nested under `ios` for Expo. */
type PermissionPromptEntry = { ios: Record<PermissionPlistKey, string> };

/** The Expo top-level `locales` map: one `ios` entry per supported language. */
export type PermissionPromptLocales = Record<SupportedLanguage, PermissionPromptEntry>;

function readPrompt(
  copy: Partial<Record<PermissionPlistKey, string>>,
  tag: string,
  key: PermissionPlistKey
): string {
  const value = copy[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing or empty permission prompt copy for ${tag}.${key}`);
  }
  return value;
}

/**
 * Builds the Expo top-level `locales` map from the prebuild-time copy. The
 * `ios` nesting is load-bearing: Android's `withLocales` reads the same field,
 * and without it an Android prebuild would emit `values-b+<tag>/strings.xml`
 * holding `NS*` keys.
 *
 * Throws when a supported language or any of the five keys is missing or
 * empty, so a prebuild fails loudly instead of shipping an English prompt.
 */
export function buildPermissionPromptLocales(copy: PermissionPromptCopy): PermissionPromptLocales {
  const entries: [SupportedLanguage, PermissionPromptEntry][] = [];
  for (const tag of SUPPORTED_LANGUAGES) {
    const entry = copy[tag];
    if (!entry) {
      throw new Error(`Missing permission prompt copy for language: ${tag}`);
    }
    entries.push([
      tag,
      {
        ios: {
          NSMicrophoneUsageDescription: readPrompt(entry, tag, 'NSMicrophoneUsageDescription'),
          NSSpeechRecognitionUsageDescription: readPrompt(
            entry,
            tag,
            'NSSpeechRecognitionUsageDescription'
          ),
          NSFaceIDUsageDescription: readPrompt(entry, tag, 'NSFaceIDUsageDescription'),
          NSLocationWhenInUseUsageDescription: readPrompt(
            entry,
            tag,
            'NSLocationWhenInUseUsageDescription'
          ),
          NSUserTrackingUsageDescription: readPrompt(entry, tag, 'NSUserTrackingUsageDescription'),
        },
      },
    ]);
  }
  return Object.fromEntries(entries) as PermissionPromptLocales;
}
