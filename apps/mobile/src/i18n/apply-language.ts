import { reloadAppAsync } from 'expo';
import { I18nManager } from 'react-native';

import { i18n } from '@/i18n';
import { readDirectionAttemptAsync, writeDirectionAttemptAsync } from '@/i18n/direction-attempt';
import { type SupportedLanguage } from '@/i18n/languages';
import { isRtlLanguage, syncRtl } from '@/i18n/rtl';
import { type LanguageReturnTarget, writeLanguageReturnTarget } from '@/i18n/return-target';
import {
  type LanguagePreference,
  setLanguagePreferenceAsync,
} from '@/lib/hooks/use-language-preference';
import { registerNeedsInputCategories } from '@/lib/notification-actions';
import { renameAndroidNotificationChannels } from '@/lib/notifications';
import { prewarmIntl } from '@/lib/intl-cache';

export type ApplyLanguageOutcome =
  | { kind: 'applied-ltr' }
  | { kind: 'restarting-rtl' }
  | { kind: 'restart-skipped' }
  | { kind: 'reload-failed' }
  | { kind: 'persist-failed' }
  | { kind: 'catalog-failed' };

/** Switch the i18n instance in place; false when the catalog failed to load. */
async function changeLanguageInPlace(language: string): Promise<boolean> {
  try {
    // The plural-rules polyfill must be in place before the first render in the new language.
    prewarmIntl(language);
    await i18n.changeLanguage(language);
  } catch {
    return false;
  }
  // `changeLanguage` never rejects on a lazy-backend read failure: i18next
  // records the failed entry and resolves, leaving the previous language
  // active. The bundle set is the check that matters, and the direct-load
  // recovery of `activateLanguage` must not run here — a router-level catalog
  // failure is one the follow reports instead of repairing in place.
  return i18n.hasResourceBundle(language, 'translation');
}

/** Re-localize the notification surfaces for the language now applied. */
function refreshLocalizedNotifications(): void {
  void renameAndroidNotificationChannels();
  // The launch-time category registration ran under the previous language, so
  // re-register the needs-input action buttons in the applied one (same
  // localization pass as the channel rename above; idempotent).
  void registerNeedsInputCategories();
}

/**
 * Force the native direction for `language` and reload the app.
 *
 * `respectAttemptRecord` is the automatic follow's loop guard: the record
 * names the language the last launch relaunches for and only a cold start
 * whose direction already matches clears it, so a device change the app
 * re-receives while it sits on the language retry screen must not relaunch
 * again for the same language — the platform already refused that direction
 * once and a second reload would repeat with no user input. A manual pick
 * never reads the record: the person asking again is exactly the input the
 * guard protects, and the retry path re-runs the apply itself.
 */
async function restartForDirection(
  language: SupportedLanguage,
  respectAttemptRecord: boolean
): Promise<ApplyLanguageOutcome> {
  if (respectAttemptRecord && (await readDirectionAttemptAsync()) === language) {
    return { kind: 'restart-skipped' };
  }
  // Record the relaunch so a cold start that comes back with the previous
  // direction does not relaunch again for it; the cold start then shows the
  // retry screen instead of reloading forever. Without the record a relaunch
  // that does not take the direction repeats on every launch, so a failed
  // write skips the relaunch instead of risking that loop.
  if (!(await writeDirectionAttemptAsync(language))) {
    return { kind: 'restart-skipped' };
  }
  syncRtl(language);
  try {
    await reloadAppAsync();
  } catch {
    return { kind: 'reload-failed' };
  }
  return { kind: 'restarting-rtl' };
}

/**
 * Persist a language preference and apply it. When the native direction must
 * change, write the preference first, force the direction, and reload. When
 * the direction stays the same, switch the i18n instance in place and persist
 * only after the catalog loads, rolling the copy back if the persist fails.
 * Never throws: every failure maps to an outcome the picker can render.
 */
// eslint-disable-next-line eslint/max-params -- beforeReload is the optional draft flush the picker passes through
export async function applyLanguagePreference(
  preference: LanguagePreference,
  resolved: SupportedLanguage,
  // Optional: the manual picker reopens the screen it was on, while an
  // agent-driven change has no screen of its own and reloads to the default.
  returnTarget?: LanguageReturnTarget,
  beforeReload?: () => Promise<void>
): Promise<ApplyLanguageOutcome> {
  if (I18nManager.isRTL !== isRtlLanguage(resolved)) {
    const persisted = await setLanguagePreferenceAsync(preference);
    if (!persisted) {
      return { kind: 'persist-failed' };
    }

    try {
      // The draft flush is a convenience; a failure must not block the language change.
      await beforeReload?.();
    } catch {
      // Ignore: the reload below still applies the direction change.
    }
    try {
      // The return target is a convenience; the reload still applies the
      // direction change and the user lands on the default screen when this
      // write fails. A caller with no screen to reopen omits it.
      if (returnTarget !== undefined) {
        await writeLanguageReturnTarget(returnTarget);
      }
    } catch {
      // Ignore: continue to the reload.
    }
    return restartForDirection(resolved, false);
  }

  const previousLanguage = i18n.language;
  if (!(await changeLanguageInPlace(resolved))) {
    return { kind: 'catalog-failed' };
  }

  const persisted = await setLanguagePreferenceAsync(preference, previousLanguage);
  if (!persisted) {
    // The rollback is best-effort; the persist failure already surfaced.
    await changeLanguageInPlace(previousLanguage);
    return { kind: 'persist-failed' };
  }

  refreshLocalizedNotifications();
  return { kind: 'applied-ltr' };
}

/**
 * Apply the device language after the device locale changed, while the stored
 * preference is `device`. Same steps as {@link applyLanguagePreference} except
 * the persist: the stored preference is already `device`, and the person may
 * pick a language while this runs, so writing here would clobber that pick.
 * Never throws: every failure maps to an outcome the caller reports.
 */
export async function applyDeviceLanguage(
  language: SupportedLanguage
): Promise<ApplyLanguageOutcome> {
  if (I18nManager.isRTL !== isRtlLanguage(language)) {
    return restartForDirection(language, true);
  }

  if (!(await changeLanguageInPlace(language))) {
    return { kind: 'catalog-failed' };
  }

  refreshLocalizedNotifications();
  return { kind: 'applied-ltr' };
}
