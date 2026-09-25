import { RefreshControl as NativeRefreshControl, type RefreshControlProps } from 'react-native';

import { useMotionPolicy } from '@/lib/a11y/motion';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function RefreshControl({ refreshing, ...props }: Readonly<RefreshControlProps>) {
  const { reducedMotion } = useMotionPolicy();
  const colors = useThemeColors();

  return (
    <NativeRefreshControl
      {...props}
      colors={props.colors ?? [colors.primary]}
      tintColor={props.tintColor ?? colors.primary}
      refreshing={reducedMotion ? false : refreshing}
    />
  );
}
