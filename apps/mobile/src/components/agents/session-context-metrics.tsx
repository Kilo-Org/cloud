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
  getPillSlotSizers,
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
 * The pill holds the ring, then the two value slots its reading fills. `gap-1.5`
 * keeps the reading clear of the ring, and the row's own `gap-1` separates the
 * percentage from the cost, so the parts of a settled reading each stand on
 * their own.
 *
 * Each slot is laid out at the width of the widest reading it can paint and
 * paints nothing itself, so a slot whose value has not arrived keeps that width
 * invisibly. A settled empty chat therefore reads as a finished, empty control
 * instead of carrying a placeholder glyph, and a reading that arrives fills the
 * slot it already showed instead of resizing the pill beside the title and the
 * trailing control.
 *
 * `shrink min-w-0` keeps the pill inside the header's capped trailing slot: RN's
 * default flexShrink is 0, so without them the pill would paint past the row's
 * right edge. Inside the capped pill the slots give up width before the pill
 * does, and each reading keeps to one line.
 *
 * The padding and the ring-to-reading gap are `px-2.5` and `gap-1.5` rather than
 * the wider `px-3` and `gap-2`: the reserved slots make the pill the widest
 * control in the header, and the compact window gives the title exactly the
 * rest, so those few dp were the difference between the title's own badge
 * fitting and being clipped by its row.
 */
const PILL_CLASS =
  'h-[44px] shrink min-w-0 flex-row items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5';
const VALUE_ROW_CLASS = 'min-w-0 shrink flex-row items-center gap-1';
const VALUE_SLOT_CLASS = 'min-w-0 shrink justify-center';
const PRIMARY_VALUE_CLASS = 'text-xs tabular-nums';
const COST_VALUE_CLASS = 'text-xs tabular-nums';

/**
 * Full-bleed box over the value row that centres the loading bar in it. The row
 * is sized by its own slots, so its width and height follow the font scale; the
 * bar takes those instead of a fixed size of its own.
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

/**
 * One value slot of the pill.
 *
 * The sizer is a copy of the widest reading the slot can paint, in the slot's
 * own text classes, and it paints nothing: it holds the width and the line box
 * so the slot reads as part of the pill before its value exists. The reading
 * paints over it, centred in the width it reserved. Both come from the same
 * formatters, so the slot holds at every font scale and in every locale.
 */
function PillValueSlot({
  sizer,
  value,
  textClassName,
  accessibilityHidden = false,
}: Readonly<{
  sizer: string;
  value: string | null;
  textClassName: string;
  accessibilityHidden?: boolean;
}>) {
  return (
    <View className={VALUE_SLOT_CLASS}>
      <Text
        numberOfLines={1}
        className={cn(textClassName, 'opacity-0')}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {sizer}
      </Text>
      {value === null ? null : (
        <Text
          numberOfLines={1}
          className={cn(textClassName, 'absolute inset-x-0 top-0 text-center')}
          {...(accessibilityHidden
            ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
            : {})}
        >
          {value}
        </Text>
      )}
    </View>
  );
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

  // A value has no placeholder glyph: the percentage paints once the session
  // reports it, and the cost paints once it is known. A slot whose value is not
  // there keeps its width and paints nothing, so the pill never stands a dash in
  // for a number that has not arrived. A session that reported tokens but no
  // context window has no honest percentage either, so that slot paints nothing;
  // the ring's indeterminate arc, the accessibility label and the context sheet
  // carry the unknown.
  const costLabel =
    content.costSlot === 'label' && content.secondary !== null
      ? isolateLtrBidiText(content.secondary)
      : null;
  // While the session still resolves, one bar covers the row the two slots lay
  // out. A bar of its own fixed width matched that row only at the default font
  // scale; the row itself is the correct extent at any scale, so the overlay
  // takes its size instead of naming one.
  const valueRowLoading = content.costSlot === 'loading';
  const sizers = getPillSlotSizers();

  const body = (
    <>
      <ContextUsageRing
        size={RING_SIZE}
        strokeWidth={RING_STROKE}
        arcFraction={content.arcFraction}
        tone={content.tone}
      />
      <View className={VALUE_ROW_CLASS}>
        <PillValueSlot
          sizer={sizers.percentage}
          value={content.primary}
          textClassName={cn(PRIMARY_VALUE_CLASS, 'font-semibold', TONE_TEXT_CLASS[content.tone])}
        />
        <PillValueSlot
          sizer={sizers.cost}
          value={costLabel}
          textClassName={cn(COST_VALUE_CLASS, 'text-muted-foreground')}
          accessibilityHidden
        />
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
