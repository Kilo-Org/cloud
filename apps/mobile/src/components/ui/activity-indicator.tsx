import { Loader2 } from '@/components/ui/icons';
import {
  type ActivityIndicatorProps,
  ActivityIndicator as NativeActivityIndicator,
  View,
} from 'react-native';

import { useMotionPolicy } from '@/lib/a11y/motion';
import { darkColors } from '@/lib/hooks/theme-colors.generated';

function indicatorDimension(size: ActivityIndicatorProps['size']): number {
  if (size === 'large') {
    return 36;
  }
  if (size === 'small' || size === undefined) {
    return 20;
  }
  return size;
}

export function ActivityIndicator({
  size = 'small',
  color,
  animating = true,
  hidesWhenStopped = true,
  style,
  ...props
}: Readonly<ActivityIndicatorProps>) {
  const { reducedMotion } = useMotionPolicy();

  if (!reducedMotion) {
    return (
      <NativeActivityIndicator
        {...props}
        animating={animating}
        color={color}
        hidesWhenStopped={hidesWhenStopped}
        size={size}
        style={style}
      />
    );
  }

  return (
    <View {...props} className="items-center justify-center" style={style}>
      {/* Lucide strokes at `currentColor`, which react-native-svg resolves to
          black when no color is given, so fall back to the muted foreground the
          native spinner and `RefreshControl` already default to. The generated
          palette is read directly, like `RefreshControl`, to keep this
          component free of the theme hook that suites stub `react-native` for. */}
      <Loader2
        size={indicatorDimension(size)}
        color={
          !animating && hidesWhenStopped ? 'transparent' : (color ?? darkColors.mutedForeground)
        }
      />
    </View>
  );
}
