import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { formatSessionCostBadge } from './session-list-helpers';
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
  /**
   * Marks a settled session that will never report usage and cannot open any
   * sheet: an empty stored transcript reports no usage, and its sheet has no
   * permission settings (read-only sessions cannot auto-approve). The layout
   * box stays reserved so the header does not shift; the dash value would
   * otherwise read as a permanent placeholder beside the finished empty state.
   */
  onNothingToReport?: boolean;
};

const RING_SIZE = 28;
const RING_STROKE = 3;

/**
 * The pill paints only what it holds: a ring, and the values the session has
 * reported so far, with one small gap between them. Values that arrive later
 * must not move the row the pill ends, so the pill sits inside a box that keeps
 * its width.
 *
 * That box is the widest content the pill can show: a hidden, zero-height copy
 * of the pill laid out with the widest reading each value can take. It is built
 * by the same formatters the painted values use, so a catalog that puts a space
 * before the percent sign, or a four-figure cost that keeps a grouping
 * separator, reserve the room they need at any font scale. Both sizers are
 * layout measurements and never reach a reader.
 *
 * The box is `items-end`, so the pill keeps the trailing edge the header gives
 * it and the reserve it does not use stays in the gap before it, where the row
 * already has empty space. A pill that hugs its content therefore reads as the
 * compact control it is — a circle around the ring when the session reports
 * nothing, one short reading when it does — while the Follow control beside the
 * box never moves.
 *
 * The pill paints the ring alone until a value exists, so it has one silhouette
 * for as long as it has nothing to read. The reserve already holds the row's
 * width, so a bar in the pill's own value area would add a second, wider
 * silhouette that collapses the moment the session settles.
 */
export const WIDEST_PERCENTAGE_VALUE = 100;
export const WIDEST_COST_MICRODOLLARS = 1_234_560_000;
const PILL_CLASS =
  'h-[44px] shrink min-w-0 flex-row items-center gap-1 rounded-full border border-border bg-secondary px-3';
const VALUE_CLASS = 'min-w-0 shrink text-xs tabular-nums';

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
  // Without an `onPress` this is the unresolved-session placeholder: the layout
  // box keeps its space in every state, and stays invisible while there is
  // nothing to open. A settled session that will never report usage and cannot
  // open the sheet hides the same way, so its value never paints as a permanent
  // placeholder.
  const hidden =
    !pressable && (loading || (!hasMessages && !autoApproveAvailable) || onNothingToReport);
  const accessibilityLabel = getMetricsAccessibilityLabel({
    info,
    totalCostMicrodollars,
    interactive: pressable,
    usageUnavailable: content.usageUnavailable,
  });

  const percentageSizer = formatPercent(WIDEST_PERCENTAGE_VALUE, i18n.language);
  const costSizer = formatSessionCostBadge(WIDEST_COST_MICRODOLLARS) ?? percentageSizer;
  const costLabel =
    content.costSlot === 'label' && content.secondary !== null
      ? isolateLtrBidiText(content.secondary)
      : null;

  // One text run paints the reading, so a value that arrives later grows the run
  // it belongs to instead of moving a neighbouring value. The cost is a value
  // read left to right, so it stays isolated from the percentage beside it.
  const valueRun = (
    primary: string | null,
    cost: string | null,
    invisible: boolean
  ): React.ReactElement | null => {
    if (primary === null && cost === null) {
      return null;
    }
    return (
      <Text
        numberOfLines={1}
        className={cn(VALUE_CLASS, invisible && 'opacity-0')}
        {...(invisible
          ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
          : {})}
      >
        {primary !== null ? (
          <Text className={cn('font-semibold', TONE_TEXT_CLASS[content.tone])}>{primary}</Text>
        ) : null}
        {primary !== null && cost !== null ? ' ' : null}
        {cost !== null ? <Text className="text-muted-foreground">{cost}</Text> : null}
      </Text>
    );
  };

  const pill = (
    <>
      <ContextUsageRing
        size={RING_SIZE}
        strokeWidth={RING_STROKE}
        arcFraction={content.arcFraction}
        tone={content.tone}
      />
      {valueRun(content.primary, costLabel, false)}
    </>
  );

  // The reserve: a zero-height copy of the widest reading the pill can show. Its
  // width decides the box; it paints nothing, and its own height is clipped so
  // it never adds to the pill's.
  const reserve = (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-0 shrink min-w-0 overflow-hidden"
    >
      <View className={PILL_CLASS}>
        <View style={{ width: RING_SIZE, height: RING_SIZE }} />
        {valueRun(percentageSizer, costSizer, true)}
      </View>
    </View>
  );

  const paintedPill = pressable ? (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      className={cn(PILL_CLASS, 'active:opacity-70')}
      testID="session-context-metrics"
    >
      {pill}
    </Pressable>
  ) : (
    <View
      accessibilityLabel={accessibilityLabel || undefined}
      {...(hidden
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
        : {})}
      className={cn(PILL_CLASS, hidden && 'opacity-0')}
      testID="session-context-metrics"
    >
      {pill}
    </View>
  );

  return (
    <View className="h-[44px] shrink min-w-0 items-end">
      {reserve}
      {paintedPill}
    </View>
  );
}
