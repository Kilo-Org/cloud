import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { isolateLtrBidiText } from '@/lib/bidi';
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
   * Empty sessions keep the pill's layout box. `onPress` decides whether the
   * pill is live — the parent passes it whenever the context sheet can open —
   * so the box never swallows a tap.
   */
  hasMessages: boolean;
  autoApproveAvailable?: boolean;
  onPress?: () => void;
  /**
   * Marks the unresolved-session placeholder. The pill stays hidden while there
   * is nothing to open.
   */
  loading?: boolean;
  /**
   * Marks a settled session that will never report usage and cannot open any
   * sheet: an empty stored transcript reports no usage, and its sheet has no
   * permission settings (read-only sessions cannot auto-approve). The pill then
   * stays hidden, because the track-only ring would read as a permanent
   * placeholder beside the finished empty state.
   */
  onNothingToReport?: boolean;
};

const RING_SIZE = 28;
const RING_STROKE = 3;

/**
 * The pill hugs what it holds: the ring, then the values the session has
 * reported. `gap-2` keeps the reading clear of the ring, and the value row's own
 * `gap-1` separates the percentage from the cost, so the three parts of a
 * settled reading each stand on their own.
 *
 * The pill is the cluster's leading control, beside the trailing action, so a
 * reading that arrives widens it into the row and the heading beside it gives up
 * that width — the heading keeps its own line cap and tail ellipsis. `shrink
 * min-w-0` keeps the pill inside the header's capped trailing slot: RN's default
 * flexShrink is 0, so without them a long reading would paint past the row's
 * right edge. The percentage is a few glyphs at most, so it keeps its width; the
 * cost is the only unbounded part, so it is the one that truncates to one line.
 */
const PILL_CLASS =
  'h-[44px] shrink min-w-0 flex-row items-center gap-2 rounded-full border border-border bg-secondary px-3';
const VALUE_ROW_CLASS = 'min-w-0 shrink flex-row items-baseline gap-1';
const PRIMARY_VALUE_CLASS = 'shrink-0 text-xs tabular-nums';
const COST_VALUE_CLASS = 'min-w-0 shrink text-xs tabular-nums';

const TONE_TEXT_CLASS = {
  destructive: 'text-destructive',
  warning: 'text-warn',
  primary: 'text-foreground',
  neutral: 'text-foreground',
} satisfies Record<ContextTone, string>;

export function SessionContextMetrics({
  info,
  totalCostMicrodollars,
  hasMessages,
  autoApproveAvailable = false,
  onPress,
  loading = false,
  onNothingToReport = false,
}: Readonly<SessionContextMetricsProps>) {
  const content = getHeaderPillContent({ info, totalCostMicrodollars, hasMessages, loading });
  // This pill is the only way into the session's context sheet, which owns the
  // session's permission settings (auto-approve). The parent provides `onPress`
  // whenever the sheet can open for this session, so pressability follows that
  // and never the page's load phase or whether usage has arrived: a session
  // whose transcript is still loading — or failed to load — must not leave its
  // settings behind a control that looks dead or an invisible tap target.
  const pressable = onPress != null;
  // Without an `onPress` this is the unresolved-session placeholder: the box
  // keeps its space in every state, and stays invisible while there is nothing
  // to open. A settled session that will never report usage and cannot open the
  // sheet hides the same way, so its value never paints as a permanent
  // placeholder.
  const hidden =
    !pressable && (loading || (!hasMessages && !autoApproveAvailable) || onNothingToReport);
  const accessibilityLabel = getMetricsAccessibilityLabel({
    info,
    totalCostMicrodollars,
    interactive: pressable,
    usageUnavailable: content.usageUnavailable,
  });

  // A value has no placeholder: the percentage paints once the session reports
  // it, and the cost paints once it is known, so the pill never stands a dash in
  // for a number that has not arrived. A session that reported tokens but no
  // context window has no honest percentage either, so its slot paints nothing;
  // the ring's bare track, the accessibility label and the context sheet
  // carry the unknown.
  const costLabel =
    content.costSlot === 'label' && content.secondary !== null
      ? isolateLtrBidiText(content.secondary)
      : null;

  const body = (
    <>
      <ContextUsageRing
        size={RING_SIZE}
        strokeWidth={RING_STROKE}
        arcFraction={content.arcFraction}
        tone={content.tone}
      />
      {content.primary !== null || costLabel !== null ? (
        <View className={VALUE_ROW_CLASS}>
          {content.primary !== null ? (
            <Text
              numberOfLines={1}
              className={cn(PRIMARY_VALUE_CLASS, 'font-semibold', TONE_TEXT_CLASS[content.tone])}
            >
              {content.primary}
            </Text>
          ) : null}
          {costLabel !== null ? (
            <Text
              numberOfLines={1}
              className={cn(COST_VALUE_CLASS, 'text-muted-foreground')}
              accessibilityElementsHidden
              importantForAccessibility="no"
            >
              {costLabel}
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
        className={cn(PILL_CLASS, 'active:opacity-70')}
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
      className={cn(PILL_CLASS, hidden && 'opacity-0')}
      testID="session-context-metrics"
    >
      {body}
    </View>
  );
}
