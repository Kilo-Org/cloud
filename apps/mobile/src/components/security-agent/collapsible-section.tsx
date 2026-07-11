import { ChevronDown } from 'lucide-react-native';
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
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type CollapsibleSectionProps = {
  title: string;
  defaultExpanded?: boolean;
  className?: string;
  children: ReactNode;
};

// Shared collapsible section for finding-details/-analysis/-remediation
// panels (source record, technical report, attempt history) — mirrors
// tool-card-shell.tsx's chevron-rotation pattern but adds the
// accessibilityState the security-agent brief calls for.
export function CollapsibleSection({
  title,
  defaultExpanded = false,
  className,
  children,
}: Readonly<CollapsibleSectionProps>) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const colors = useThemeColors();
  const rotation = useSharedValue(defaultExpanded ? 180 : 0);

  useEffect(() => {
    rotation.value = withTiming(expanded ? 180 : 0, { duration: 200 });
  }, [expanded, rotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      layout={LinearTransition.duration(200)}
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
        <Animated.View entering={FadeIn.duration(150)} className="gap-2">
          {children}
        </Animated.View>
      )}
    </Animated.View>
  );
}
