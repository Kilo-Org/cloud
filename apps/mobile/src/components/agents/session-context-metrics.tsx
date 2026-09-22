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
  /**
   * Empty sessions reserve the pill's layout box. `onPress` decides whether the
   * pill is live — the parent passes it whenever the context sheet can open —
   * so the reserved box never swallows a tap.
   */
  hasMessages: boolean;
  autoApproveAvailable?: boolean;
  onPress?: () => void;
  /**
   * Marks the unresolved-session placeholder. The layout box stays reserved so
   * the header does not shift; the pill itself stays hidden only while there is
   * nothing to open.
   */
  loading?: boolean;
};

const RING_SIZE = 28;
const RING_STROKE = 3;

const TONE_TEXT_CLASS = {
  destructive: 'text-destructive',
  warning: 'text-warn',
  primary: 'text-foreground',
  neutral: 'text-foreground',
} satisfies Record<ContextTone, string>;

function toneTextClass(tone: ContextTone): string {
  return TONE_TEXT_CLASS[tone];
}

export function SessionContextMetrics({
  info,
  totalCostMicrodollars,
  hasMessages,
  autoApproveAvailable = false,
  onPress,
  loading = false,
}: Readonly<SessionContextMetricsProps>) {
  const content = getHeaderPillContent({ info, totalCostMicrodollars, hasMessages });
  // This pill is the only way into the session's context sheet, which owns the
  // session's permission settings (auto-approve). The parent provides `onPress`
  // whenever the sheet can open for this session, so pressability follows that
  // and never the page's load phase or whether usage has arrived: a session
  // whose transcript is still loading — or failed to load — must not leave its
  // settings behind a control that looks dead or an invisible tap target.
  const pressable = onPress != null;
  // Without an `onPress` this is the unresolved-session placeholder: the layout
  // box keeps its space in every state, and stays invisible while there is
  // nothing to open.
  const hidden = !pressable && (loading || (!hasMessages && !autoApproveAvailable));
  const accessibilityLabel = getMetricsAccessibilityLabel({
    info,
    totalCostMicrodollars,
    interactive: pressable,
  });

  // Exactly 44pt via h-[44px]. rem-scaled h-11 measured ~38.7pt on device with
  // NativeWind 5 preview (rem ≈ 14px here), so an arbitrary px value is required
  // for the 44pt minimum touch target; height is identical in every pill state.
  // `min-w-0 shrink` lets the pill give up width to the header's 50% slot cap
  // instead of painting the cost past the gutter.
  const pillClassName =
    'h-[44px] min-w-0 shrink flex-row items-center gap-2 rounded-full border border-border bg-secondary px-3';

  // Without context usage the cost is the primary string; with usage the cost
  // sits beside the percentage. Either way the cost is the only unbounded text
  // in the pill, so the slot that carries it must be able to truncate.
  const primaryIsCost = info == null;

  const body = (
    <>
      <ContextUsageRing
        size={RING_SIZE}
        strokeWidth={RING_STROKE}
        arcFraction={content.arcFraction}
        tone={content.tone}
      />
      {content.primary != null ? (
        <View className="min-w-0 shrink flex-row items-baseline gap-1">
          <Text
            className={cn(
              'text-xs font-semibold tabular-nums',
              toneTextClass(content.tone),
              primaryIsCost && 'min-w-0 shrink'
            )}
            numberOfLines={1}
          >
            {content.primary}
          </Text>
          {content.hasCost && content.secondary ? (
            <Text
              className="min-w-0 shrink text-xs tabular-nums text-muted-foreground"
              numberOfLines={1}
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
      {...(hidden
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
        : {})}
      className={cn(pillClassName, hidden && 'opacity-0')}
      testID="session-context-metrics"
    >
      {body}
    </View>
  );
}
