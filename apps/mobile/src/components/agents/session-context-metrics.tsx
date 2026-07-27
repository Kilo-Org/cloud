import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { ContextUsageRing } from './context-usage-ring';
import {
  type ContextTone,
  getHeaderPillContent,
  getMetricsAccessibilityLabel,
} from './context-usage-display';
import { SessionPlatformIcon } from './session-platform-icon';

type SessionContextMetricsProps = {
  info: SessionContextInfo | undefined;
  platform: string | null | undefined;
  totalCostMicrodollars: number | null;
  hasMessages: boolean;
  onPress?: () => void;
};

const RING_SIZE = 28;
const RING_STROKE = 3;
const GLYPH_SIZE = 14;

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
  platform,
  totalCostMicrodollars,
  hasMessages,
  onPress,
}: Readonly<SessionContextMetricsProps>) {
  const colors = useThemeColors();
  const content = getHeaderPillContent({ info, totalCostMicrodollars, hasMessages });
  const accessibilityLabel = getMetricsAccessibilityLabel({
    info,
    totalCostMicrodollars,
    platform,
    interactive: content.interactive,
  });

  // Fixed 44pt height (h-11). Baseline measured 40pt with min-h-11 + py-1.5
  // (ring 28 + vertical padding), so min-h was inert; h-11 makes the claimed
  // 44pt minimum touch target real and identical in every pill state.
  const pillClassName =
    'h-11 flex-row items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5';

  const body = (
    <>
      <View className="h-7 w-7 items-center justify-center">
        <View className="absolute inset-0">
          <ContextUsageRing
            size={RING_SIZE}
            strokeWidth={RING_STROKE}
            arcFraction={content.arcFraction}
            tone={content.tone}
          />
        </View>
        <SessionPlatformIcon platform={platform} size={GLYPH_SIZE} color={colors.mutedForeground} />
      </View>
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

  if (content.interactive && onPress) {
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
      className={pillClassName}
      testID="session-context-metrics"
    >
      {body}
    </View>
  );
}
