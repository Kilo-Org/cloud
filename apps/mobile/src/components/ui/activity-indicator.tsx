import { Loader2 } from '@/components/ui/icons';
import {
  type ActivityIndicatorProps,
  ActivityIndicator as NativeActivityIndicator,
  View,
} from 'react-native';

import { useMotionPolicy } from '@/lib/a11y/motion';

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
      <Loader2
        size={indicatorDimension(size)}
        color={!animating && hidesWhenStopped ? 'transparent' : color}
      />
    </View>
  );
}
