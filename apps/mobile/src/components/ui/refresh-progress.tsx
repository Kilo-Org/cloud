import { type ScrollViewProps, View } from 'react-native';

import { Loader2 } from '@/components/ui/icons';
import { useProvidedMotionPolicy } from '@/lib/a11y/motion-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type RefreshProgressProps = {
  refreshControl: NonNullable<ScrollViewProps['refreshControl']>;
};

/**
 * The height `RefreshProgress` reserves whenever reduced motion is on: its
 * `h-9` static-progress box (2.25rem, i.e. 31.5dp at NativeWind's 14pt rem).
 * The box is always reserved under reduced motion — only the spinner inside is
 * conditional — so a centered state's band, and any presentation decision
 * measured against it, can read the same reserve without a pull in flight.
 */
export const REFRESH_PROGRESS_REDUCED_MOTION_HEIGHT = 31.5;

export function RefreshProgress({ refreshControl }: Readonly<RefreshProgressProps>) {
  const reducedMotion = useProvidedMotionPolicy()?.reducedMotion ?? false;
  const themeColors = useThemeColors();
  const { colors, refreshing, tintColor } = refreshControl.props;
  const showStaticProgress = reducedMotion && refreshing;

  return (
    <View
      accessibilityRole={showStaticProgress ? 'progressbar' : undefined}
      // `h-9` is `REFRESH_PROGRESS_REDUCED_MOTION_HEIGHT`; keep them in step.
      className={`${reducedMotion ? 'h-9' : 'h-0'} items-center justify-center`}
      pointerEvents="none"
    >
      {showStaticProgress ? (
        <Loader2 color={tintColor ?? colors?.[0] ?? themeColors.mutedForeground} size={20} />
      ) : null}
    </View>
  );
}
