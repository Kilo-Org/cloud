import { Pressable, View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
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
 * The pill lays out the two value slots its reading fills, then the ring. The
 * row's own `gap-1` separates the percentage from the cost, and the ring
 * button's own inner padding separates the reserved row from the ring: the pill
 * needs no gap of its own between them.
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
 * The ring ends the pill rather than leading it, so its own round button sits in
 * the header's action group beside the two icon controls. `ps-2.5 pe-0` leaves
 * the leading padding around the reserved row and none at the end: the ring
 * button's capsule reaches the pill's edge, and the cluster's own `gap-2` — the
 * same 7 dp the two icon controls keep between them — then separates it from
 * the control beside the pill. Every dp between the ring and that control is the
 * gap the header itself gives its controls, so nothing reads as a control that
 * drifted away from its neighbours.
 *
 * The row ends flush against the ring button's border, and the button's own
 * inner padding — its 42 dp square inside the 44 dp pill around a 28 dp ring,
 * 7 dp on each side — is what separates the reading from the ring. That is why
 * the pill carries no `gap-1.5` of its own: the same clearance came out of the
 * button, and the pill is the header's widest control, so the reserved dp it
 * saves is room the title keeps.
 *
 * Exactly one chrome is visible in every state, and only the one that has
 * something to show wears it. While the pill paints a reading or the loading bar
 * it wears the outer capsule, and the ring button stays transparent inside it.
 * While it paints nothing — a settled empty chat — the outer capsule goes
 * transparent and the ring button wears the capsule instead, so the header shows
 * one round, bordered, filled button where a reading would be, not a wide empty
 * box with a ring floating at its leading edge.
 *
 * The border is always there, one dp on every side, and only its colour and the
 * fill follow the reading, on both boxes: the pill and its ring button each keep
 * their border slot, so neither the box nor the button moves by a border's width
 * when the first reading arrives.
 */
const PILL_CLASS = 'h-[44px] shrink min-w-0 flex-row items-center rounded-full border ps-2.5 pe-0';
/** The capsule worn while the pill paints a reading: the pill's own. */
const PILL_CAPSULE_CLASS = 'border-border bg-secondary';
/** The chrome a settled pill wears while it paints nothing: transparent outer box. */
const PILL_BARE_CLASS = 'border-transparent';

/**
 * The ring's own round button: the pill's content height square — 42 dp inside
 * the 44 dp pill, whose one-dp borders take the other two — with one dp of
 * border on every side and fully rounded, so the ring is drawn inside a circle
 * rather than floating in an empty box. The width follows the height through
 * `aspect-square`, so the button stays circular at any pill height.
 */
const RING_BUTTON_CLASS =
  'h-full aspect-square shrink-0 items-center justify-center rounded-full border';
/** The fill a ring button wears while it is the pill's only visible chrome. */
const RING_BUTTON_CAPSULE_CLASS = 'border-border bg-secondary';
/** The chrome a ring button wears inside the pill's own capsule. */
const RING_BUTTON_BARE_CLASS = 'border-transparent bg-transparent';
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
  // context window has no honest percentage either, so its slot paints nothing;
  // the ring's bare track, the accessibility label and the context sheet
  // carry the unknown.
  const costLabel = content.costSlot === 'label' ? content.secondary : null;
  // While the session still resolves, one bar covers the row the two slots lay
  // out. A bar of its own fixed width matched that row only at the default font
  // scale; the row itself is the correct extent at any scale, so the overlay
  // takes its size instead of naming one.
  const valueRowLoading = content.costSlot === 'loading';
  const sizers = getPillSlotSizers();
  // Exactly one chrome is visible at a time. A pill that paints nothing at all
  // shows none of its own: on a settled empty chat an empty wide capsule reads
  // as a control that broke or never finished loading. The ring button takes
  // the capsule instead, so the header shows the one control the pill has to
  // offer there, and the first reading swaps the two without moving either box.
  const showsReading = content.primary !== null || costLabel !== null || valueRowLoading;
  const chromeClass = showsReading ? PILL_CAPSULE_CLASS : PILL_BARE_CLASS;
  const ringChromeClass = showsReading ? RING_BUTTON_BARE_CLASS : RING_BUTTON_CAPSULE_CLASS;

  const body = (
    <>
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
      <View className={cn(RING_BUTTON_CLASS, ringChromeClass)}>
        <ContextUsageRing
          size={RING_SIZE}
          strokeWidth={RING_STROKE}
          arcFraction={content.arcFraction}
          tone={content.tone}
        />
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
        className={cn(PILL_CLASS, chromeClass, 'active:opacity-70')}
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
      className={cn(PILL_CLASS, chromeClass, hidden && 'opacity-0')}
      testID="session-context-metrics"
    >
      {body}
    </View>
  );
}
