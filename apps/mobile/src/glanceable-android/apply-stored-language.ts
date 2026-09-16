import { i18n } from '@/i18n';
import {
  getResolvedLanguage,
  whenLanguagePreferenceLoaded,
} from '@/lib/hooks/use-language-preference';

/**
 * Switch i18n to the user's language before a headless Android surface renders.
 *
 * A widget redraw and the notification's Approve task both run as headless JS
 * with no Activity, so the app's root never mounts and nothing else applies the
 * stored language — without this the placed widget and the republished
 * notification render English whatever the user chose.
 */
export async function applyStoredLanguage(): Promise<void> {
  await whenLanguagePreferenceLoaded();
  const language = getResolvedLanguage();
  if (i18n.language !== language) {
    await i18n.changeLanguage(language);
  }
}
