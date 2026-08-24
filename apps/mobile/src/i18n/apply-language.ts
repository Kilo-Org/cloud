import { reloadAppAsync } from 'expo';
import { I18nManager } from 'react-native';

import { i18n } from '@/i18n';
import { type SupportedLanguage } from '@/i18n/languages';
import { isRtlLanguage, syncRtl } from '@/i18n/rtl';
import { type LanguageReturnTarget, writeLanguageReturnTarget } from '@/i18n/return-target';
import {
  type LanguagePreference,
  setLanguagePreferenceAsync,
} from '@/lib/hooks/use-language-preference';
import { renameAndroidNotificationChannels } from '@/lib/notifications';

export type ApplyLanguageOutcome =
  | { kind: 'applied-ltr' }
  | { kind: 'restarting-rtl' }
  | { kind: 'reload-failed' }
  | { kind: 'persist-failed' }
  | { kind: 'catalog-failed' };

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
  returnTarget: LanguageReturnTarget,
  beforeReload?: () => Promise<void>
): Promise<ApplyLanguageOutcome> {
  const needsDirectionChange = I18nManager.isRTL !== isRtlLanguage(resolved);

  if (needsDirectionChange) {
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
      // write fails.
      await writeLanguageReturnTarget(returnTarget);
    } catch {
      // Ignore: continue to the reload.
    }
    syncRtl(resolved);
    try {
      await reloadAppAsync();
    } catch {
      return { kind: 'reload-failed' };
    }
    return { kind: 'restarting-rtl' };
  }

  const previousLanguage = i18n.language;
  try {
    await i18n.changeLanguage(resolved);
  } catch {
    return { kind: 'catalog-failed' };
  }

  const persisted = await setLanguagePreferenceAsync(preference);
  if (!persisted) {
    try {
      await i18n.changeLanguage(previousLanguage);
    } catch {
      // Ignore: the rollback is best-effort; the persist failure already surfaced.
    }
    return { kind: 'persist-failed' };
  }

  void renameAndroidNotificationChannels();
  return { kind: 'applied-ltr' };
}
