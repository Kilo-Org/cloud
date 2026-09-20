import { i18n } from '@/i18n';
import {
  getResolvedLanguage,
  whenLanguagePreferenceLoaded,
} from '@/lib/hooks/use-language-preference';

/**
 * Switch i18n to the user's language before a press or a headless surface
 * renders.
 *
 * These paths can run with no Activity and no mounted app root — the Android
 * widget redraw and Approve task boot headless JS, and an iOS Live Activity
 * press can launch the process in the background — so nothing else applies the
 * stored language and every translated string would render English whatever the
 * user chose. Foreground callers already have it applied, and this is then a
 * no-op.
 */
export async function applyStoredLanguage(): Promise<void> {
  await whenLanguagePreferenceLoaded();
  const language = getResolvedLanguage();
  if (i18n.language !== language) {
    await i18n.changeLanguage(language);
  }
}
