import {
  GLANCEABLE_STALE_MS,
  type GlanceableAgentsSnapshot,
  isIdleOnlyGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import {
  type GlanceableCountKind,
  glanceableCountLines,
  glanceableScheduledAt,
  glanceableSpokenLabel,
  type GlanceableStatus,
  glanceableStatusCopyKey,
  type GlanceableSurfaceFlags,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';
import { getSurfaceExtras, type GlanceableSurfaceExtras } from '@/lib/glanceable/surface-extras';

/** One translated count line. `kind` picks the glyph and the color. */
type GlanceableCount = { label: string; kind: GlanceableCountKind; count: number };

/**
 * The props every iOS surface renders. The builder below is the only producer,
 * so a title, organization name, account id, or raw session id can never reach
 * the widget extension.
 */
export type GlanceableViewProps = {
  /** Translated locked copy; null while counts show (happy). Stale carries both. */
  statusLine: string | null;
  /** Non-zero count lines in rank order (needs-input, running, scheduled, idle). */
  countLines: GlanceableCount[];
  /** Top-ranked count label for compact surfaces; null when no eligible work. */
  primaryLabel: string | null;
  /** Top-ranked count state for compact surfaces; null when no eligible work. */
  primaryKind: GlanceableCountKind | null;
  /** Top-ranked count value for compact surfaces; 0 when no eligible work. */
  primaryCount: number;
  /**
   * The reserved slot under the counts: the newest session's title, the
   * in-flight action's progress or failure line, or null. Only the Home Screen
   * families draw it. The title never enters the snapshot (privacy contract):
   * it rides in the surface extras every surface reads on redraw (see
   * surface-extras), and the props builder owns the translated copy.
   */
  newestTitle: string | null;
  /** The two in-place actions the state offers. Disabled actions draw no button. */
  actions: { approve: boolean; newAgent: boolean };
  /**
   * ISO timestamp of the longest-running needs-input wait, or null when
   * nothing waits. Only the needs-input row carries a duration: a wait is the
   * one interval the user can act on. Only `systemMedium` is wide enough to
   * draw it.
   */
  needsInputSince: string | null;
  /**
   * ISO timestamp of the soonest scheduled wake, or null when nothing is
   * scheduled or no scheduled row carried a wake time. Only the scheduled
   * count row carries it; the medium and large Home Screen cards are wide
   * enough to draw it.
   */
  scheduledAt: string | null;
  /**
   * Kind of the most recent agent state change, or null while no counts show.
   * The locked frames (waiting/empty/expired/signed-out/privacy) report no
   * work at all, so their card draws only the status line.
   */
  newestResultKind: GlanceableCountKind | null;
  /**
   * The translated label for that kind, taken from the matching `countLines`
   * row, so the footer can never name the work differently from the count
   * above it.
   */
  newestResultLabel: string | null;
  /** ISO timestamp of that newest change; null on the same locked frames. */
  newestResultAt: string | null;
  /** Spoken label: status word, numeric counts, then Open agents. Never a title or id. */
  accessibilityLabel: string;
};

/**
 * The marker a widget button's App Intent patches into the pressed entry's
 * props, until the app answers: `pendingAction` names the action to run and
 * `pendingActionVisible` holds the "Approving…" line in place of the newest
 * line. The app clears both the moment it picks the press up, so a crash or a
 * second sweep can never run the same press twice.
 */
export type GlanceableWidgetAction = 'approve' | 'new-agent';

export type GlanceableWidgetProps = Partial<GlanceableViewProps> & {
  pendingAction?: GlanceableWidgetAction;
  pendingActionVisible?: boolean;
};

/**
 * The reserved slot line: the newest session's title, or the in-flight action's
 * progress or failure while one is being answered.
 *
 * The slot is visible on every surface that offers an in-place action — the two
 * count statuses, including an idle-only tray, and the empty one — because a
 * create's progress and failure have nowhere else to appear, and the empty
 * surface and an idle-only tray are the ones that offer `New agent`. The
 * newest-session *title* still draws only where the counts do, so a locked or
 * empty surface stays titleless.
 */
function newestTitleFor(
  extras: GlanceableSurfaceExtras,
  status: GlanceableStatus,
  translate: (key: string) => string
): string | null {
  if (status !== 'happy' && status !== 'stale' && status !== 'empty') {
    return null;
  }
  if (extras.actionFeedback === 'approving') {
    return translate('glanceable.approving');
  }
  if (extras.actionFeedback === 'starting') {
    return translate('common.starting');
  }
  if (extras.actionFeedback === 'couldNotApprove') {
    return translate('glanceable.couldNotApprove');
  }
  if (extras.actionFeedback === 'couldNotStart') {
    return translate('glanceable.couldNotStart');
  }
  if (status !== 'happy' && status !== 'stale') {
    return null;
  }
  const title = extras.newestSessionTitle;
  if (title === null) {
    return null;
  }
  // The translator owns the word order around the placeholder. The replacer is
  // a function so a title containing `$&` or `$'` is inserted literally
  // instead of being read as a replacement pattern.
  return translate('glanceable.newestSession').replace('{{title}}', () => title);
}

/** Build the surface props from a snapshot, surface flags, and a translator. */
export function buildGlanceableViewProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string
): GlanceableViewProps {
  const statusKey = glanceableStatusCopyKey(snapshot, flags);
  const primary = primaryGlanceableCount(snapshot);
  // Only these two statuses draw rows; the rest draw their status line, so the
  // locked frames carry no count payload at all.
  const status = resolveGlanceableStatus(snapshot, flags);
  const showCounts = status === 'happy' || status === 'stale';
  const countLines = (showCounts ? glanceableCountLines(snapshot) : []).map(line => ({
    label: translate(line.key),
    kind: line.kind,
    count: line.count,
  }));
  const newestResultKind = showCounts ? snapshot.newestResultKind : null;
  // The label comes from the row above rather than a second translation of the
  // same word, so the footer and the count can never be worded differently.
  const newestResultLabel =
    newestResultKind === null
      ? null
      : (countLines.find(line => line.kind === newestResultKind)?.label ?? null);

  // The empty surface offers `New agent`, so its copy says what that action is
  // about — nothing waiting — instead of the generic no-work copy.
  const copy = (key: string): string =>
    key === 'glanceable.empty' ? translate('glanceable.noneWaiting') : translate(key);

  return {
    statusLine: statusKey === null ? null : copy(statusKey),
    countLines,
    primaryLabel: primary === null ? null : translate(primary.key),
    primaryKind: primary === null ? null : primary.kind,
    primaryCount: primary === null ? 0 : primary.count,
    newestTitle: newestTitleFor(getSurfaceExtras(), status, translate),
    actions: {
      // Only a permission wait can be answered from the widget, so the button
      // gates on `needsApproval` (the count the Live Activity's own Approve
      // control uses). A `question` needs an answer and a `retry` needs the
      // provider back: neither is approvable, so neither may offer a button the
      // action can only answer by opening the app.
      approve: showCounts && (snapshot.needsApproval ?? 0) > 0,
      // Nothing waiting to act on: the empty state, or an idle-only tray that
      // keeps a card alive. A locked or expired surface offers neither.
      newAgent: status === 'empty' || (showCounts && isIdleOnlyGlanceableWork(snapshot)),
    },
    needsInputSince: showCounts && snapshot.needsInput > 0 ? snapshot.needsInputSince : null,
    // The shared helper decides the wake, so a scheduled count with no usable
    // time is represented the same way on this surface as on every other.
    scheduledAt: showCounts ? glanceableScheduledAt(snapshot) : null,
    newestResultKind,
    newestResultLabel,
    newestResultAt: newestResultKind === null ? null : snapshot.newestResultAt,
    accessibilityLabel: glanceableSpokenLabel(snapshot, flags, copy),
  };
}

/**
 * Drop the null fields before a widget write.
 *
 * `updateTimeline` stores the props in the shared `UserDefaults`, which rejects
 * a null value and throws an Objective-C exception out through the host
 * function. An absent key reads back as `undefined`, which every layout already
 * defaults, so omitting the field is the lossless form.
 */
export function toWidgetProps(props: GlanceableViewProps): Partial<GlanceableViewProps> {
  const entries = Object.entries(props).filter(([, value]) => value !== null);
  return Object.fromEntries(entries) as Partial<GlanceableViewProps>;
}

/**
 * The widget's stale frame: the same counts under the delayed copy, for the
 * timeline entry that lands once a whole stale window has passed with no
 * refresh. The counts stay — they are still the last thing the device knew —
 * and only the claim that they are current is dropped.
 */
function buildStaleWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string
): Partial<GlanceableViewProps> {
  return toWidgetProps(buildGlanceableViewProps({ ...snapshot, status: 'stale' }, {}, translate));
}

/**
 * The delayed frame, when there is a claim worth retracting. Counts only: an
 * empty or waiting surface asserts nothing that can go out of date, and a
 * `stale` frame after `expiresAt` would only undo the expiry frame behind it.
 */
export function staleTimelineFrame(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string
): { date: Date; props: Partial<GlanceableViewProps> }[] {
  if (snapshot.status !== 'happy') {
    return [];
  }
  const staleAt = Date.parse(snapshot.updatedAt) + GLANCEABLE_STALE_MS;
  return staleAt >= Date.parse(snapshot.expiresAt)
    ? []
    : [{ date: new Date(staleAt), props: buildStaleWidgetProps(snapshot, translate) }];
}

/**
 * The widget's expiry frame: the same snapshot with its counts zeroed and the
 * expired copy, for the timeline entry that lands at `expiresAt`.
 */
export function buildExpiredWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string
): Partial<GlanceableViewProps> {
  return toWidgetProps(
    buildGlanceableViewProps(
      {
        ...snapshot,
        status: 'expired',
        running: 0,
        needsInput: 0,
        idle: 0,
        scheduled: 0,
        needsInputSince: null,
        scheduledAt: null,
      },
      {},
      translate
    )
  );
}

/**
 * The Live Activity content-state plus the two facts the widget extension
 * cannot derive: whether the recorded ask is one Approve can answer, and the
 * one-line notice a retryable Approve leaves on the card. Both fields are
 * additive — a server-written state omits them, and the layout reads an absent
 * notice as "nothing to say".
 */
export type GlanceableLiveActivityProps = GlanceableLiveActivityContentState & {
  canApprove?: boolean;
  /** Translated failure line for the next update; omitted when there is none. */
  notice?: string;
};

/**
 * The widget timeline for one snapshot running from `now`: the current frame,
 * then the delayed frame that stops asserting the counts as current and the
 * expiry frame that zeroes them.
 *
 * WidgetKit is the only clock the widget has while the app is not running, so
 * every writer that replaces the timeline must hand it the whole set — the
 * publisher's sink (`ios-sink.publish`) and the failure republish after a press
 * (`glanceable-ios/widget-actions`). A single-frame write drops the two
 * fallbacks and the widget keeps claiming the line it was last given.
 *
 * `null` for a terminal blank: `updateSnapshot` already wrote its single
 * current frame, and the delayed copy must never replace signed-out or privacy
 * copy.
 */
export function widgetTimelineFrames(
  snapshot: GlanceableAgentsSnapshot,
  props: Partial<GlanceableViewProps>,
  translate: (key: string) => string
): { date: Date; props: Partial<GlanceableViewProps> }[] | null {
  if (snapshot.status === 'signed_out' || snapshot.status === 'privacy') {
    return null;
  }
  const now = Date.now();
  // WidgetKit renders the newest entry at or before `now` and never rewinds, so
  // a frame whose date has already passed sits behind the current one and only
  // leaves the timeline unsorted. A press on a widget whose last snapshot
  // lapsed while the app was away therefore keeps the single current frame.
  const later = [
    ...staleTimelineFrame(snapshot, translate),
    { date: new Date(snapshot.expiresAt), props: buildExpiredWidgetProps(snapshot, translate) },
  ].filter(frame => frame.date.getTime() > now);
  return [{ date: new Date(now), props }, ...later];
}

/**
 * Build the Live Activity content-state from a snapshot. The server pushes the
 * same raw shape, so the widget extension's `active-agents-live-activity.tsx`
 * renders it directly with inlined English copy (the server cannot translate).
 * `canApprove` and `notice` are included only when the caller can decide them;
 * a server-written state omits both.
 *
 * The approvable count rides only here, never in `GlanceableViewProps`: the
 * widget's own in-place buttons read it from the snapshot while `actions` is
 * built, and the Lock Screen / Watch Smart Stack layout draws its Approve
 * control from this content state. A snapshot from an older producer omits the
 * field, so it resolves to 0 and both controls are hidden rather than offering
 * an Approve the service could not complete.
 */
export function buildGlanceableLiveActivityContentState(
  snapshot: GlanceableAgentsSnapshot,
  canApprove?: boolean,
  notice?: string
): GlanceableLiveActivityProps {
  return {
    status: snapshot.status,
    running: snapshot.running,
    needsInput: snapshot.needsInput,
    needsApproval: snapshot.needsApproval ?? 0,
    idle: snapshot.idle,
    needsInputSince: snapshot.needsInputSince,
    scheduled: snapshot.scheduled,
    scheduledAt: snapshot.scheduledAt,
    ...(canApprove === undefined ? {} : { canApprove }),
    ...(notice === undefined ? {} : { notice }),
  };
}
