import { useLocales } from 'expo-localization';
import { useEffect } from 'react';

import { requestDeviceLanguageFollow } from '@/i18n/device-language-follow';
import { resolveLanguageTag } from '@/i18n/resolve-language';

/**
 * Applies a device language change while the app runs. `useLocales` re-renders
 * this node on a configuration change, so only this leaf re-renders and the
 * rest of the tree keeps its state. `enabled` holds the follow back until the
 * startup apply has finished: at a cold start the language is already applied,
 * and following it again would reload twice for a direction change.
 */
export function DeviceLanguageFollow({ enabled }: { readonly enabled: boolean }) {
  const deviceLanguage = resolveLanguageTag(useLocales());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    requestDeviceLanguageFollow(deviceLanguage);
  }, [deviceLanguage, enabled]);

  return null;
}
