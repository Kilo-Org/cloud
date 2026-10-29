import { I18nManager } from 'react-native';

import { RTL_LANGUAGES, type SupportedLanguage } from './languages';

export function isRtlLanguage(language: SupportedLanguage): boolean {
  return RTL_LANGUAGES.has(language);
}

/**
 * Force the native direction when it does not match the resolved language.
 * Returns true when a direction change was applied (the caller must then
 * reload the app before first paint).
 *
 * Both switches have to be written, because the platform keeps the direction
 * itself rather than reading the app's language: it reports RTL when the
 * direction is forced, or when it is allowed and the *device* locale reads
 * right to left. `forceRTL(false)` therefore only stops forcing RTL — on a
 * device whose own locale is RTL the running direction would stay RTL — and
 * `allowRTL(false)` is what withdraws the device locale's say. The reverse
 * pair keeps RTL working on a left-to-right device.
 */
export function syncRtl(language: SupportedLanguage): boolean {
  const shouldBeRtl = isRtlLanguage(language);
  if (I18nManager.isRTL !== shouldBeRtl) {
    I18nManager.allowRTL(shouldBeRtl);
    I18nManager.forceRTL(shouldBeRtl);
    return true;
  }
  return false;
}
