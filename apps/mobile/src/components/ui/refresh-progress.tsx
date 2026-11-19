import { type ReactElement } from 'react';
import { type RefreshControlProps, useColorScheme, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Loader2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useProvidedMotionPolicy } from '@/lib/a11y/motion-context';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

type RefreshProgressProps = {
  refreshControl: ReactElement<RefreshControlProps>;
};

/**
 * The height `RefreshProgress` reserves whenever reduced motion is on: its
 * `h-9` static-progress box (2.25rem, i.e. 31.5dp at NativeWind's 14pt rem).
 * The box is always reserved under reduced motion — only the indicator inside
 * is conditional — so a centered state's band, and any presentation decision
 * measured against it, can read the same reserve without a pull in flight.
 */
export const REFRESH_PROGRESS_REDUCED_MOTION_HEIGHT = 31.5;

export function RefreshProgress({ refreshControl }: Readonly<RefreshProgressProps>) {
  const { t } = useTranslation();
  const reducedMotion = useProvidedMotionPolicy()?.reducedMotion ?? false;
  const { colors, refreshing, tintColor } = refreshControl.props;
  // The indicator's default color follows the same token `RefreshControl`
  // hands the native control, on the scheme the device reports now.
  const schemeMutedForeground =
    useColorScheme() === 'dark' ? darkColors.mutedForeground : lightColors.mutedForeground;
  const showStaticProgress = reducedMotion && refreshing;

  // The reserve box stays a plain, inaccessible wrapper; the indicator is its
  // own accessible child, so the node carrying the progress semantics exists
  // only while a pull is in flight. RN's Android wiring never clears the busy
  // state a view reports once the prop goes back to `undefined` (it reads the
  // tag it last stored, and `setViewState` returns early on `null`), so
  // unmounting — not clearing props — is what removes the state.
  return (
    <View
      // `h-9` is `REFRESH_PROGRESS_REDUCED_MOTION_HEIGHT`; keep them in step.
      className={`${reducedMotion ? 'h-9' : 'h-0'} items-center justify-center`}
      pointerEvents="none"
    >
      {showStaticProgress ? (
        // The static indicator names itself: a reader hears the progressbar
        // role, the loading label, and the in-progress state, because the
        // platform control it replaces is inert under reduced motion. The
        // label rides a visually hidden text child, the same channel
        // `AccessibleStatus` opens: the platform aggregates a child's text
        // into the owning node's name.
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityState={{ busy: true }}
          className="absolute inset-0 items-center justify-center"
        >
          <Text className="absolute size-px overflow-hidden">{t('common.loading')}</Text>
          <Loader2 color={tintColor ?? colors?.[0] ?? schemeMutedForeground} size={20} />
        </View>
      ) : null}
    </View>
  );
}
