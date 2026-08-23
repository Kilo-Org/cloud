import { I18nManager } from 'react-native';

import { RTL_LANGUAGES, type SupportedLanguage } from './languages';

// Run before the first view mounts so the native direction is known before
// any layout pass (see the import at the top of src/app/_layout.tsx).
I18nManager.allowRTL(true);

export function isRtlLanguage(language: SupportedLanguage): boolean {
  return RTL_LANGUAGES.has(language);
}

/**
 * Force the native direction when it does not match the resolved language.
 * Returns true when a direction change was applied (the caller must then
 * reload the app before first paint).
 */
export function syncRtl(language: SupportedLanguage): boolean {
  const shouldBeRtl = isRtlLanguage(language);
  if (I18nManager.isRTL !== shouldBeRtl) {
    I18nManager.forceRTL(shouldBeRtl);
    return true;
  }
  return false;
}
