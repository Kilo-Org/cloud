import { reloadAppAsync } from 'expo';

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
 * Persist a language preference and apply it. LTR languages switch the i18n
 * instance in place; RTL languages write a one-shot return target, force the
 * native direction, and reload the app. Never throws: every failure maps to
 * an outcome the picker can render.
 */
export async function applyLanguagePreference(
  preference: LanguagePreference,
  resolved: SupportedLanguage,
  returnTarget: LanguageReturnTarget
): Promise<ApplyLanguageOutcome> {
  const persisted = await setLanguagePreferenceAsync(preference);
  if (!persisted) {
    return { kind: 'persist-failed' };
  }

  if (isRtlLanguage(resolved)) {
    try {
      await writeLanguageReturnTarget(returnTarget);
    } catch {
      return { kind: 'persist-failed' };
    }
    syncRtl(resolved);
    try {
      await reloadAppAsync();
    } catch {
      return { kind: 'reload-failed' };
    }
    return { kind: 'restarting-rtl' };
  }

  try {
    await i18n.changeLanguage(resolved);
  } catch {
    return { kind: 'catalog-failed' };
  }
  void renameAndroidNotificationChannels();
  return { kind: 'applied-ltr' };
}
