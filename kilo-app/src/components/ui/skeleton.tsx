import { useEffect } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { cn } from '@/lib/utils';

type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className }: Readonly<SkeletonProps>) {
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 1000 }), -1, true);
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return <Animated.View className={cn('rounded-md bg-muted', className)} style={animatedStyle} />;
}
