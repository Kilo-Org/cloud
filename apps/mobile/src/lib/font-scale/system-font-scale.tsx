import { type ReactNode, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { readLiveFontScale, subscribeToFontScale } from '@/lib/font-scale/native-font-scale';
import { SystemFontScaleContext } from '@/lib/font-scale/system-font-scale-context';

/**
 * The system font scale as the app currently needs it.
 *
 * React Native's own `Dimensions`/`useWindowDimensions().fontScale` is stale
 * while the app stays in the foreground: its `DeviceInfoModule` caches the
 * value at launch and refreshes it only when the host resumes. A font-size
 * change is handled by the activity in place, so nothing resumes. The
 * `KiloFontScale` module reads the value from the live resources and emits it
 * on every configuration change; this provider is the one subscription every
 * text node reads it through.
 */
export function SystemFontScaleProvider({ children }: { readonly children: ReactNode }) {
  const [fontScale, setFontScale] = useState(readLiveFontScale);

  useEffect(() => {
    const subscription = subscribeToFontScale(setFontScale);
    // A resume re-reads the same value: a change may have landed while the app
    // was in the background, where the module's callback is not delivered.
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setFontScale(readLiveFontScale());
      }
    });
    return () => {
      subscription?.remove();
      appStateSubscription.remove();
    };
  }, []);

  return (
    <SystemFontScaleContext.Provider value={fontScale}>{children}</SystemFontScaleContext.Provider>
  );
}
