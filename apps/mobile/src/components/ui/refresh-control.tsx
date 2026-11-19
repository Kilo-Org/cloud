import {
  RefreshControl as NativeRefreshControl,
  type RefreshControlProps,
  useColorScheme,
} from 'react-native';

import { useMotionPolicy } from '@/lib/a11y/motion';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

/**
 * Android draws its pull indicator with the platform accent — a saturated blue
 * that belongs to no screen in this app (device defect model-picker). Default it
 * to the active color scheme's muted foreground — the token `RefreshProgress`
 * falls back to — so a screen that picks no color still shows app chrome
 * instead of system chrome.
 *
 * The generated palette is read directly, like `RefreshProgress`, to keep this
 * component free of the theme hook: it renders inside suites that stub
 * `react-native`, and `useThemeColors` would pull `expo-router` in behind them.
 */
export function RefreshControl({ refreshing, ...props }: Readonly<RefreshControlProps>) {
  const { reducedMotion } = useMotionPolicy();
  const indicatorColor =
    useColorScheme() === 'dark' ? darkColors.mutedForeground : lightColors.mutedForeground;

  return (
    <NativeRefreshControl
      {...props}
      colors={props.colors ?? [indicatorColor]}
      tintColor={props.tintColor ?? indicatorColor}
      refreshing={reducedMotion ? false : refreshing}
    />
  );
}
