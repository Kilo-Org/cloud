import { i18n } from '@/i18n';
import {
  getResolvedLanguage,
  whenLanguagePreferenceLoaded,
} from '@/lib/hooks/use-language-preference';
import { prewarmIntl } from '@/lib/intl-cache';

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
 *
 * A headless surface also builds the text it shows here: card titles, targets
 * and commands are cut on character boundaries through their own module, which
 * reads `Intl.Segmenter` and Hermes has none. `prewarmIntl` installs the
 * segmenter along with every other formatter a surface reads, so the same warm
 * covers the text a background widget or notification cuts before any render.
 *
 * The warm runs before the language change — not after — because i18next caches
 * each language's plural rule the first time it resolves one. Hermes ships no
 * `Intl.PluralRules`, so a rule resolved before the polyfill and its locale
 * data are installed is memoised as English's one/other pair and stays that way
 * for the process; a widget redrawn headless in Russian or Arabic would then
 * show the English singular for every count.
 */
export async function applyStoredLanguage(): Promise<void> {
  await whenLanguagePreferenceLoaded();
  const language = getResolvedLanguage();
  prewarmIntl(language);
  if (i18n.language !== language) {
    await i18n.changeLanguage(language);
  }
}
