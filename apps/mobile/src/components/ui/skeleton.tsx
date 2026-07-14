import { useEffect } from 'react';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { cn } from '@/lib/utils';

type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className }: Readonly<SkeletonProps>) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    if (!reducedMotion) {
      opacity.value = withRepeat(withTiming(1, { duration: 1000 }), -1, true);
    }

    return () => {
      cancelAnimation(opacity);
    };
  }, [opacity, reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    // Static muted block when reduced motion is on — no shimmer loop.
    opacity: reducedMotion ? 0.7 : opacity.value,
  }));

  return <Animated.View className={cn('rounded-md bg-muted', className)} style={animatedStyle} />;
}
