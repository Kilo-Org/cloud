import { PERMISSION_PROMPT_PLIST_KEYS } from '../lib/permission-prompt-plist-keys.js';
import { buildCopyByLanguage, readNonEmptyCopy } from './prebuild-copy.ts';
import { type SupportedLanguage } from './languages.ts';

export { PERMISSION_PROMPT_PLIST_KEYS };

type PermissionPlistKey = (typeof PERMISSION_PROMPT_PLIST_KEYS)[number];

/** Prebuild-time copy, one entry per language tag. */
export type PermissionPromptCopy = Record<string, Partial<Record<PermissionPlistKey, string>>>;

/** The prebuild-time copy for one language, nested under `ios` for Expo. */
type PermissionPromptEntry = { ios: Record<PermissionPlistKey, string> };

/** The Expo top-level `locales` map: one `ios` entry per supported language. */
export type PermissionPromptLocales = Record<SupportedLanguage, PermissionPromptEntry>;

/**
 * Builds the Expo top-level `locales` map from the prebuild-time copy. The
 * `ios` nesting is load-bearing: Android's `withLocales` reads the same field,
 * and without it an Android prebuild would emit `values-b+<tag>/strings.xml`
 * holding `NS*` keys.
 *
 * Every `ios` map is filled from `PERMISSION_PROMPT_PLIST_KEYS`, the same list
 * scripts/assert-expo-config.mjs checks, so the builder can only write keys the
 * assertion accepts. Throws when a supported language or any required key is
 * missing or empty, so a prebuild fails loudly instead of shipping an English
 * prompt.
 */
export function buildPermissionPromptLocales(copy: PermissionPromptCopy): PermissionPromptLocales {
  return buildCopyByLanguage(copy, 'permission prompt', (entry, tag) => {
    const ios = Object.fromEntries(
      PERMISSION_PROMPT_PLIST_KEYS.map(key => [
        key,
        readNonEmptyCopy(entry, tag, key, 'permission prompt'),
      ])
    ) as Record<PermissionPlistKey, string>;
    return { ios };
  });
}
