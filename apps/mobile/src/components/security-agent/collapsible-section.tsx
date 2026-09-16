import { ChevronDown } from '@/components/ui/icons';
import { type ReactNode, useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/text';
import { selectReducedMotionEntrance, useMotionPolicy } from '@/lib/a11y/motion';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type CollapsibleSectionProps = {
  title: string;
  defaultExpanded?: boolean;
  className?: string;
  children: ReactNode;
};

// Shared collapsible section for finding-details/-analysis/-remediation
// panels (source record, technical report, attempt history) — the
// transcript tool cards dropped this chevron-rotation pattern when they
// moved to fixed rows; this section keeps it and adds the
// accessibilityState the security-agent brief calls for.
export function CollapsibleSection({
  title,
  defaultExpanded = false,
  className,
  children,
}: Readonly<CollapsibleSectionProps>) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const colors = useThemeColors();
  const { reducedMotion } = useMotionPolicy();
  const rotation = useSharedValue(defaultExpanded ? 180 : 0);

  useEffect(() => {
    // Reduced motion jumps the chevron straight to its target angle instead of
    // a 200ms timing; the layout transition and content fade are dropped below.
    const target = expanded ? 180 : 0;
    rotation.value = reducedMotion ? target : withTiming(target, { duration: 200 });
  }, [expanded, reducedMotion, rotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      layout={reducedMotion ? undefined : LinearTransition.duration(200)}
      className={cn('gap-2 rounded-lg bg-secondary p-3', className)}
    >
      <Pressable
        className="flex-row items-center justify-between gap-2"
        hitSlop={12}
        onPress={() => {
          setExpanded(current => !current);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={title}
      >
        <Text className="flex-1 text-sm font-medium">{title}</Text>
        <Animated.View style={chevronStyle}>
          <ChevronDown size={16} color={colors.mutedForeground} />
        </Animated.View>
      </Pressable>
      {expanded && (
        <Animated.View
          entering={selectReducedMotionEntrance(reducedMotion, FadeIn.duration(150))}
          className="gap-2"
        >
          {children}
        </Animated.View>
      )}
    </Animated.View>
  );
}
