import { type NativeModule, requireOptionalNativeModule } from 'expo';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';

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
 *
 * `null` means no live value: a build without the module, and the app tree
 * rendered before the provider mounts.
 */

type FontScaleModule = InstanceType<
  typeof NativeModule<{ onFontScaleChange: (event: { fontScale: number }) => void }>
> & {
  getFontScale: () => number;
};

const nativeModule = requireOptionalNativeModule<FontScaleModule>('KiloFontScale');

function readLiveFontScale(): number {
  const scale = nativeModule?.getFontScale() ?? 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

const SystemFontScaleContext = createContext<number | null>(null);

export function SystemFontScaleProvider({ children }: { readonly children: ReactNode }) {
  const [fontScale, setFontScale] = useState(readLiveFontScale);

  useEffect(() => {
    const subscription = nativeModule?.addListener('onFontScaleChange', event => {
      setFontScale(event.fontScale);
    });
    // A resume re-reads the same value: the change may have landed while the
    // app was in the background, where the module's callback is not delivered.
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

/** The live system font scale, or `null` outside the provider. */
export function useSystemFontScale(): number | null {
  return useContext(SystemFontScaleContext);
}
