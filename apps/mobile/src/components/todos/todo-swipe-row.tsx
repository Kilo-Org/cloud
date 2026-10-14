import * as Haptics from 'expo-haptics';
import { type ReactNode, useRef } from 'react';
import { View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
  SwipeDirection,
} from 'react-native-gesture-handler/ReanimatedSwipeable';

import { type LucideIcon } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type SwipeTone = 'primary' | 'warn' | 'destructive';

export type TodoSwipeAction = {
  label: string;
  icon: LucideIcon;
  tone: SwipeTone;
  onTrigger: () => void;
};

const TONE_CLASS = {
  primary: { panel: 'bg-primary', text: 'text-primary-foreground' },
  warn: { panel: 'bg-warn', text: 'text-warn-foreground' },
  destructive: { panel: 'bg-destructive', text: 'text-destructive-foreground' },
} as const satisfies Record<SwipeTone, { panel: string; text: string }>;

function SwipePanel({ action, align }: { action: TodoSwipeAction; align: 'start' | 'end' }) {
  const colors = useThemeColors();
  const iconColor = {
    primary: colors.primaryForeground,
    warn: colors.warnForeground,
    destructive: colors.destructiveForeground,
  }[action.tone];
  const Icon = action.icon;
  return (
    <View
      className={cn(
        'flex-1 flex-row items-center px-6',
        TONE_CLASS[action.tone].panel,
        align === 'start' ? 'justify-start' : 'justify-end'
      )}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <View className="items-center gap-1">
        <Icon size={18} color={iconColor} />
        <Text className={cn('text-xs font-semibold', TONE_CLASS[action.tone].text)}>
          {action.label}
        </Text>
      </View>
    </View>
  );
}

/**
 * A row with a full-swipe action on either side: swiping right runs
 * `swipeRight`, swiping left runs `swipeLeft`. The panel closes as the action
 * fires. Screen readers reach the same actions through the row's
 * `accessibilityActions`, which the caller declares.
 */
export function TodoSwipeRow({
  children,
  swipeRight,
  swipeLeft,
}: Readonly<{ children: ReactNode; swipeRight?: TodoSwipeAction; swipeLeft?: TodoSwipeAction }>) {
  const ref = useRef<SwipeableMethods>(null);
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1.5}
      leftThreshold={96}
      rightThreshold={96}
      overshootFriction={8}
      renderLeftActions={
        swipeRight ? () => <SwipePanel action={swipeRight} align="start" /> : undefined
      }
      renderRightActions={
        swipeLeft ? () => <SwipePanel action={swipeLeft} align="end" /> : undefined
      }
      onSwipeableOpen={direction => {
        // A swipe to the right reveals the left-side panel.
        const action = direction === SwipeDirection.RIGHT ? swipeRight : swipeLeft;
        ref.current?.close();
        if (action) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          action.onTrigger();
        }
      }}
    >
      {children}
    </ReanimatedSwipeable>
  );
}
