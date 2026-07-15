import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { ContextUsageRing } from './context-usage-ring';
import {
  type ContextTone,
  getArcFraction,
  getContextTone,
  getHeaderSummary,
  getMetricsAccessibilityLabel,
} from './context-usage-display';

type SessionContextMetricsProps = {
  info: SessionContextInfo;
  totalCost: number;
  onPress: () => void;
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
  totalCost,
  onPress,
}: Readonly<SessionContextMetricsProps>) {
  const summary = getHeaderSummary(info, totalCost);
  if (!summary) {
    return null;
  }
  const tone = getContextTone(info.percentage);
  const arcFraction = getArcFraction(info.percentage);
  const accessibilityLabel = getMetricsAccessibilityLabel(info, totalCost);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      // 44pt minimum touch target without losing the compact single-line rhythm.
      className={cn(
        'min-h-11 flex-row items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1.5 active:opacity-70'
      )}
      testID="session-context-metrics"
    >
      <ContextUsageRing
        size={RING_SIZE}
        strokeWidth={RING_STROKE}
        arcFraction={arcFraction}
        tone={tone}
      />
      <View className="flex-row items-baseline gap-1">
        <Text className={cn('text-xs font-semibold tabular-nums', toneTextClass(tone))}>
          {summary.primary}
        </Text>
        {summary.hasCost && summary.secondary ? (
          <Text
            className="text-xs tabular-nums text-muted-foreground"
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            {summary.secondary}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

// Preserves the legacy positive-cost header text when no completed context
// usage exists. Marked noninteractive; VoiceOver reads the cost directly.
export function SessionContextCostFallback({ totalCost }: Readonly<{ totalCost: number }>) {
  if (totalCost <= 0) {
    return null;
  }
  return (
    <Text
      className="text-sm text-muted-foreground"
      accessibilityLabel={`Session cost $${totalCost.toFixed(4)}`}
    >
      ${totalCost.toFixed(4)}
    </Text>
  );
}
