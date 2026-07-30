import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { ContextUsageRing } from './context-usage-ring';
import {
  type ContextTone,
  getHeaderPillContent,
  getMetricsAccessibilityLabel,
} from './context-usage-display';

type SessionContextMetricsProps = {
  info: SessionContextInfo | undefined;
  totalCostMicrodollars: number | null;
  hasMessages: boolean;
  onPress?: () => void;
  /**
   * Hide the pill while the session page loads; the layout box stays reserved so the header does not
   * shift.
   */
  loading?: boolean;
};

const RING_SIZE = 28;
const RING_STROKE = 3;

const TONE_TEXT_CLASS: Record<ContextTone, string> = {
  destructive: 'text-destructive',
  warning: 'text-warn',
  primary: 'text-foreground',
  neutral: 'text-foreground',
};

function toneTextClass(tone: ContextTone): string {
  return TONE_TEXT_CLASS[tone];
}

export function SessionContextMetrics({
  info,
  totalCostMicrodollars,
  hasMessages,
  onPress,
  loading = false,
}: Readonly<SessionContextMetricsProps>) {
  const content = getHeaderPillContent({ info, totalCostMicrodollars, hasMessages });
  // Single source for element kind and a11y affordance wording so a future
  // caller with interactive content but no onPress cannot advertise a tap.
  const pressable = !loading && content.interactive && onPress != null;
  const accessibilityLabel = getMetricsAccessibilityLabel({
    info,
    totalCostMicrodollars,
    interactive: pressable,
  });

  // Exactly 44pt via h-[44px]. rem-scaled h-11 measured ~38.7pt on device with
  // NativeWind 5 preview (rem ≈ 14px here), so an arbitrary px value is required
  // for the 44pt minimum touch target; height is identical in every pill state.
  const pillClassName =
    'h-[44px] flex-row items-center gap-2 rounded-full border border-border bg-secondary px-3';

  const body = (
    <>
      <ContextUsageRing
        size={RING_SIZE}
        strokeWidth={RING_STROKE}
        arcFraction={content.arcFraction}
        tone={content.tone}
      />
      {content.primary != null ? (
        <View className="flex-row items-baseline gap-1">
          <Text className={cn('text-xs font-semibold tabular-nums', toneTextClass(content.tone))}>
            {content.primary}
          </Text>
          {content.hasCost && content.secondary ? (
            <Text
              className="text-xs tabular-nums text-muted-foreground"
              accessibilityElementsHidden
              importantForAccessibility="no"
            >
              {content.secondary}
            </Text>
          ) : null}
        </View>
      ) : null}
    </>
  );

  if (pressable) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={8}
        className={cn(pillClassName, 'active:opacity-70')}
        testID="session-context-metrics"
      >
        {body}
      </Pressable>
    );
  }

  return (
    <View
      accessibilityLabel={accessibilityLabel || undefined}
      {...(loading
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
        : {})}
      className={cn(pillClassName, loading && 'opacity-0')}
      testID="session-context-metrics"
    >
      {body}
    </View>
  );
}
