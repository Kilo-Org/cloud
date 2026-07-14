import { type LucideIcon } from 'lucide-react-native';
import { useEffect } from 'react';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

type SpinningIconProps = {
  icon: LucideIcon;
  size: number;
  color: string;
  /** Whether the icon should currently be rotating. Defaults to true. */
  spinning?: boolean;
};

/** Lucide icon with an infinite-rotate loop, honoring the OS reduced-motion setting. */
export function SpinningIcon({
  icon: Icon,
  size,
  color,
  spinning = true,
}: Readonly<SpinningIconProps>) {
  const reducedMotion = useReducedMotion();
  const isAnimating = spinning && !reducedMotion;
  const rotation = useSharedValue(0);

  useEffect(() => {
    if (isAnimating) {
      rotation.value = 0;
      rotation.value = withRepeat(
        withTiming(360, { duration: 1000, easing: Easing.linear }),
        -1,
        false
      );
    } else {
      cancelAnimation(rotation);
      rotation.value = 0;
    }

    return () => {
      cancelAnimation(rotation);
    };
  }, [isAnimating, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View style={isAnimating ? animatedStyle : undefined}>
      <Icon size={size} color={color} />
    </Animated.View>
  );
}
