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
  /** Controlled expanded state. When set, the parent owns it and `onToggle` is
   *  the only way it changes; omit it to keep the internal (uncontrolled) state. */
  expanded?: boolean;
  /** Called on every header press, before the uncontrolled fallback toggles. */
  onToggle?: () => void;
  className?: string;
  titleClassName?: string;
  contentClassName?: string;
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
  expanded,
  onToggle,
  className,
  titleClassName,
  contentClassName,
  children,
}: Readonly<CollapsibleSectionProps>) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  // A controlled parent wins over the internal state so the persisted value
  // (s3's connect card) is what the chevron, the body, and a11y report.
  const resolvedExpanded = expanded ?? internalExpanded;
  const colors = useThemeColors();
  const { reducedMotion } = useMotionPolicy();
  const rotation = useSharedValue((expanded ?? defaultExpanded) ? 180 : 0);

  useEffect(() => {
    // Reduced motion jumps the chevron straight to its target angle instead of
    // a 200ms timing; the layout transition and content fade are dropped below.
    const target = resolvedExpanded ? 180 : 0;
    rotation.value = reducedMotion ? target : withTiming(target, { duration: 200 });
  }, [resolvedExpanded, reducedMotion, rotation]);

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
          onToggle?.();
          if (expanded === undefined) {
            setInternalExpanded(current => !current);
          }
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: resolvedExpanded }}
        accessibilityLabel={title}
      >
        <Text className={cn('flex-1 text-sm font-medium', titleClassName)}>{title}</Text>
        <Animated.View style={chevronStyle}>
          <ChevronDown size={16} color={colors.mutedForeground} />
        </Animated.View>
      </Pressable>
      {resolvedExpanded && (
        <Animated.View
          entering={selectReducedMotionEntrance(reducedMotion, FadeIn.duration(150))}
          className={cn('gap-2', contentClassName)}
        >
          {children}
        </Animated.View>
      )}
    </Animated.View>
  );
}
