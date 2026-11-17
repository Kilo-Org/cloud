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

import { RowGroup } from '@/components/ui/row-group';
import { Text } from '@/components/ui/text';
import { selectReducedMotionEntrance, useMotionPolicy } from '@/lib/a11y/motion';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
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
  /**
   * Whether siblings above this section may mount or resize asynchronously.
   * A layout transition animates this box's position, and Reanimated keeps the
   * box painted at its pre-change position until the transition ends, so
   * siblings that shifted are covered. Pass `false` for such a section: opacity
   * fades stay safe and the position snap does not lag. `profile-screen.tsx`
   * names the same hazard on a sibling section; see `DisclosureLayout` for the
   * transition it drops.
   */
  animateLayout?: boolean;
  /**
   * Classes on the section's outer box, for spacing against its siblings. The
   * header and body own their own insets: the header is a `RowGroup` row (the
   * card's edge plus the row's 14pt gutter), and a body whose children are
   * plain copy passes `contentClassName="px-4"` so that copy starts at the
   * header's text; children that bring a surface (a `RowGroup`, a `Card`)
   * carry both the surface and its inset themselves.
   */
  className?: string;
  titleClassName?: string;
  contentClassName?: string;
  children: ReactNode;
};

/**
 * The rotating disclosure carat, shared so the app animates a carat in one
 * place. `targetAngle` is the angle the carat settles at (180 is up, 0 is
 * down); each caller owns its own direction. Reanimated ships the same
 * implementation on iOS and Android, so this animates both platforms with one
 * implementation and is not a platform fork. Reduced motion jumps straight to
 * the angle instead of a 200ms timing.
 */
function useDisclosureRotation(targetAngle: 0 | 180) {
  const { reducedMotion } = useMotionPolicy();
  const rotation = useSharedValue(targetAngle);

  useEffect(() => {
    rotation.value = reducedMotion ? targetAngle : withTiming(targetAngle, { duration: 200 });
  }, [targetAngle, reducedMotion, rotation]);

  return useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
}

/**
 * Height transition for a block that grows or shrinks — the same Reanimated
 * layout transition on iOS and Android, so one implementation covers both and
 * the change animates instead of snapping. Reduced motion drops the transition.
 *
 * `animateLayout={false}` drops it too, for a section whose siblings above it
 * mount or resize asynchronously, and for a caller that stacks this block under
 * plain siblings in a scroll column: the transition interpolates this block's
 * frame while the siblings snap, so for its 200ms it can be drawn over the row
 * above it (the new-session connect card over the repository picker, e5 spot
 * check, 2026-09-21). Reanimated has no way to clip a transition to its own
 * box, so the caller that cannot afford the overlap opts out.
 */
export function DisclosureLayout({
  className,
  animateLayout = true,
  children,
}: Readonly<{ className?: string; animateLayout?: boolean; children: ReactNode }>) {
  const { reducedMotion } = useMotionPolicy();

  return (
    <Animated.View
      layout={reducedMotion || !animateLayout ? undefined : LinearTransition.duration(200)}
      className={className}
    >
      {children}
    </Animated.View>
  );
}

/**
 * The disclosure carat as its own pressable, for a row that already owns an
 * action: the two stay siblings, because a nested pressable disappears from
 * assistive technology inside an accessible parent. It points down when
 * expanded and up when collapsed, the goal row's affordance; `label` names the
 * action the carat performs and `expanded` is what the carat points at.
 */
export function DisclosureChevron({
  expanded,
  label,
  onPress,
}: Readonly<{
  expanded: boolean;
  label: string;
  onPress: () => void;
}>) {
  const colors = useThemeColors();
  const chevronStyle = useDisclosureRotation(expanded ? 0 : 180);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      className="h-6 w-6 shrink-0 items-center justify-center active:opacity-70"
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={label}
    >
      <Animated.View style={chevronStyle}>
        <ChevronDown size={16} color={colors.mutedForeground} />
      </Animated.View>
    </Pressable>
  );
}

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
  animateLayout = true,
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
  // This section's carat points up while it is expanded ("collapse me").
  const chevronStyle = useDisclosureRotation(resolvedExpanded ? 180 : 0);

  return (
    <DisclosureLayout className={className} animateLayout={animateLayout}>
      <RowGroup>
        {/* The disclosure header is the group's first row: the shared 48pt
            row frame, the title and the rotating carat. The carat is the
            section's own disclosure mark (`DisclosureChevron`'s sibling),
            not a navigation chevron, so it stays an icon. */}
        <Pressable
          className={cn(
            ROW_TARGET_CLASS,
            'flex-row items-center justify-between gap-3 px-4 py-3',
            'active:opacity-70'
          )}
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
      </RowGroup>
      {/* The body sits on the page, not on the header's surface: children bring
          their own `Card` / `RowGroup` / flat rows, so a disclosure can never
          nest a card inside the group it opened. */}
      {resolvedExpanded && (
        <Animated.View
          entering={selectReducedMotionEntrance(reducedMotion, FadeIn.duration(150))}
          className={cn('gap-3 pt-3', contentClassName)}
        >
          {children}
        </Animated.View>
      )}
    </DisclosureLayout>
  );
}
