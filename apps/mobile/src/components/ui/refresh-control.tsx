import { RefreshControl as NativeRefreshControl, type RefreshControlProps } from 'react-native';

import { useMotionPolicy } from '@/lib/a11y/motion';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Android draws its pull indicator with the platform accent — a saturated blue
 * that belongs to no screen in this app (device defect model-picker). Default it
 * to the same muted foreground the KiloClaw dashboard and `RefreshProgress` use,
 * so a screen that does not pick a color still shows app chrome.
 */
export function RefreshControl({ refreshing, ...props }: Readonly<RefreshControlProps>) {
  const { reducedMotion } = useMotionPolicy();
  const colors = useThemeColors();
  const indicatorColor = colors.mutedForeground;

  return (
    <NativeRefreshControl
      {...props}
      colors={props.colors ?? [indicatorColor]}
      tintColor={props.tintColor ?? indicatorColor}
      refreshing={reducedMotion ? false : refreshing}
    />
  );
}
