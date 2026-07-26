import { useEffect } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { type LayoutChangeEvent, useColorScheme, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
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

/** Soft horizontal highlight over `bg-muted` — concrete rgba, not className. */
const LIGHT_SHIMMER = [
  'rgba(255, 255, 255, 0)',
  'rgba(255, 255, 255, 0.45)',
  'rgba(255, 255, 255, 0)',
] as const;
const DARK_SHIMMER = [
  'rgba(255, 255, 255, 0)',
  'rgba(255, 255, 255, 0.1)',
  'rgba(255, 255, 255, 0)',
] as const;

const SHIMMER_DURATION_MS = 1800;

/** LinearGradient is not NativeWind-mapped; fill the absolute overlay. */
const GRADIENT_FILL = { flex: 1 } as const;

/**
 * One module-level Reanimated clock shared by every animating Skeleton.
 * Refcounted: 0→1 starts withRepeat; 1→0 cancels. Reduced-motion instances
 * never touch this clock.
 */
const shimmerProgress = makeMutable(0);
let shimmerRefCount = 0;

function retainShimmerClock(): void {
  shimmerRefCount += 1;
  if (shimmerRefCount === 1) {
    shimmerProgress.value = 0;
    shimmerProgress.value = withRepeat(
      withTiming(1, {
        duration: SHIMMER_DURATION_MS,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      false
    );
  }
}

function releaseShimmerClock(): void {
  if (shimmerRefCount <= 0) {
    return;
  }
  shimmerRefCount -= 1;
  if (shimmerRefCount === 0) {
    cancelAnimation(shimmerProgress);
    shimmerProgress.value = 0;
  }
}

export function Skeleton({ className }: Readonly<SkeletonProps>) {
  const reducedMotion = useReducedMotion();
  const colorScheme = useColorScheme();
  const layoutWidth = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      return undefined;
    }
    retainShimmerClock();
    return () => {
      releaseShimmerClock();
    };
  }, [reducedMotion]);

  const shimmerStyle = useAnimatedStyle(() => {
    const width = layoutWidth.value;
    // Before first onLayout, keep the gradient invisible / off-canvas.
    if (width <= 0) {
      return {
        opacity: 0,
        transform: [{ translateX: 0 }],
      };
    }
    // progress 0→1 maps translateX from -width (fully left) to +width (fully right).
    const translateX = -width + shimmerProgress.value * width * 2;
    return {
      opacity: 1,
      transform: [{ translateX }],
    };
  });

  const onLayout = (event: LayoutChangeEvent) => {
    layoutWidth.value = event.nativeEvent.layout.width;
  };

  // Reduced motion: static muted block at opacity 0.7 — no gradient, no clock.
  if (reducedMotion) {
    return <View className={cn('rounded-md bg-muted opacity-70', className)} />;
  }

  const shimmerColors = colorScheme === 'dark' ? DARK_SHIMMER : LIGHT_SHIMMER;

  return (
    <View className={cn('overflow-hidden rounded-md bg-muted', className)} onLayout={onLayout}>
      <Animated.View className="absolute inset-0 w-full" pointerEvents="none" style={shimmerStyle}>
        <LinearGradient
          colors={shimmerColors}
          end={{ x: 1, y: 0.5 }}
          start={{ x: 0, y: 0.5 }}
          style={GRADIENT_FILL}
        />
      </Animated.View>
    </View>
  );
}
