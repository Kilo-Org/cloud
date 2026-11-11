import { Pressable, View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { isolateLtrBidiText } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { ContextUsageRing } from './context-usage-ring';
import {
  type ContextTone,
  getHeaderPillContent,
  getMetricsAccessibilityLabel,
  UNKNOWN_WINDOW_LABEL,
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
   * box stays reserved so the header does not shift; the dash value slots
   * would otherwise read as a permanent placeholder beside the finished
   * empty state.
   */
  onNothingToReport?: boolean;
};

const RING_SIZE = 28;
const RING_STROKE = 3;

/**
 * The two value slots keep one width in every pill state: a placeholder row, a
 * dash and a settled value all occupy the same box, so the row keeps its width
 * while usage and cost arrive. The row is the trailing end of the header, so a
 * row that grew or shrank would move the whole trailing cluster, including the
 * Follow control beside it. The percentage slot holds the widest reading
 * (`100%`); the cost slot holds the widest badge the pill shows
 * (`$0.0031`). A longer cost truncates to one line inside its slot.
 */
const PRIMARY_SLOT_CLASS = 'w-8 text-center';
const COST_SLOT_CLASS = 'w-12 text-center';

/**
 * Full-bleed box over the value row that centres the loading bar in it. The row
 * keeps a fixed width, and its height follows the font scale, so the bar takes
 * those instead of a fixed size of its own.
 */
const LOADING_BAR_OVERLAY = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  justifyContent: 'center',
} as const;

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
  // open the sheet hides the same way, so its dash value slots never paint as a
  // permanent placeholder.
  const hidden =
    !pressable && (loading || (!hasMessages && !autoApproveAvailable) || onNothingToReport);
  const accessibilityLabel = getMetricsAccessibilityLabel({
    info,
    totalCostMicrodollars,
    interactive: pressable,
    usageUnavailable: content.usageUnavailable,
  });

  // Exactly 44pt via h-[44px]. rem-scaled h-11 measured ~38.7pt on device with
  // NativeWind 5 preview (rem ≈ 14px here), so an arbitrary px value is required
  // for the 44pt minimum touch target; height is identical in every pill state.
  // `shrink min-w-0` lets the pill compress inside the header's capped trailing
  // slot: RN's default flexShrink is 0, so without them the pill keeps its
  // natural width and paints past the row's right edge, off-screen. The cost is
  // the only unbounded text in the pill, so both text slots truncate to one
  // line instead of painting past the pill.
  const pillClassName =
    'h-[44px] shrink min-w-0 flex-row items-center gap-2 rounded-full border border-border bg-secondary px-3';

  // Both value slots keep one width in every pill state: the placeholder row, an
  // unresolved dash and a settled value all occupy the same box, so the row keeps
  // its width while usage and cost arrive. The row ends the trailing cluster, so
  // a row that grew or shrank would move the Follow control beside it.
  // A slot with nothing to paint keeps its dash but paints it invisible, so no
  // dash stands in for a value that has not arrived. The cost is the only
  // unbounded text here, and it truncates to one line inside its slot.
  const costLabel = content.costSlot === 'label' && content.secondary !== null;
  const costText = content.secondary ?? UNKNOWN_WINDOW_LABEL;
  // The loading state already paints the whole row invisible under its bar.
  const costUnresolved = content.costSlot === 'none';

  const primarySlot = (
    <Text
      numberOfLines={1}
      className={cn(
        'min-w-0 shrink text-xs font-semibold tabular-nums',
        PRIMARY_SLOT_CLASS,
        toneTextClass(content.tone),
        content.primary === null && 'opacity-0'
      )}
      {...(content.primary === null
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
        : {})}
    >
      {content.primary ?? UNKNOWN_WINDOW_LABEL}
    </Text>
  );

  const costSlot = (
    <Text
      numberOfLines={1}
      className={cn(
        'min-w-0 shrink text-xs tabular-nums text-muted-foreground',
        COST_SLOT_CLASS,
        costUnresolved && 'opacity-0'
      )}
      {...(costLabel
        ? {}
        : { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const })}
    >
      {costLabel ? isolateLtrBidiText(costText) : costText}
    </Text>
  );

  // While the session still resolves, the row's two dashes keep their layout and
  // paint invisible, and one bar covers the row they occupy. A bar of its own
  // fixed width matched the settled row only at the default font scale; text
  // metrics scale with the font, so the row the values will take is the correct
  // extent at any scale. The overlay centres itself in that row instead of
  // naming a vertical inset, because the row's height scales with the font too.
  const valueRowLoading = content.costSlot === 'loading';

  const body = (
    <>
      <ContextUsageRing
        size={RING_SIZE}
        strokeWidth={RING_STROKE}
        arcFraction={content.arcFraction}
        tone={content.tone}
      />
      <View className="min-w-0 shrink">
        <View
          className={cn(
            'min-w-0 shrink flex-row items-baseline gap-1',
            valueRowLoading && 'opacity-0'
          )}
          {...(valueRowLoading
            ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
            : {})}
        >
          {primarySlot}
          {costSlot}
        </View>
        {valueRowLoading ? (
          <View style={LOADING_BAR_OVERLAY}>
            <Skeleton className="h-2 w-full rounded-[2px] bg-muted-soft" />
          </View>
        ) : null}
      </View>
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
