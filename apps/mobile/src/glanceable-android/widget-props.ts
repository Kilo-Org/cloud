import {
  GLANCEABLE_STALE_MS,
  type GlanceableAgentsSnapshot,
  isIdleOnlyGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  type GlanceableCountKind,
  glanceableCountLines,
  glanceableSpokenLabel,
  type GlanceableStatus,
  glanceableStatusCopyKey,
  type GlanceableSurfaceFlags,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';
import { getSurfaceExtras, type GlanceableSurfaceExtras } from '@/lib/glanceable/surface-extras';

/** One translated count line for an Android surface. `kind` picks dot and color. */
type AndroidWidgetCount = {
  label: string;
  kind: GlanceableCountKind;
  count: string;
};

/**
 * Format a count in the active language's own digits.
 *
 * The default writes them the way `String` does, which is what the 80 languages
 * with Latin default digits need; the app injects an `Intl` formatter so fa, ps,
 * ckb, my, ne, bn, and mr read in their own numerals. Injected rather than
 * imported so this module stays free of i18n and of React Native.
 */
export type GlanceableCountFormat = (value: number) => string;

/**
 * Format a timestamp as the active language's relative time.
 *
 * Injected the same way as `formatCount` and for the same reason: this module
 * stays free of i18n and of `Intl`, so its tests need no language bootstrap and
 * the app passes `formatGlanceableAgo`.
 */
export type GlanceableAgoFormat = (at: string) => string;

/**
 * The two in-place actions a state offers, plus the translated row labels the
 * widget host draws. A disabled action's label is still carried so the widget
 * never composes copy of its own.
 */
type AndroidWidgetActions = {
  /** A session is waiting: the widget can answer its permission in place. */
  approve: boolean;
  /** Nothing waiting: the widget can start a new agent in place. */
  newAgent: boolean;
  approveLabel: string;
  newAgentLabel: string;
};

/**
 * The props the Android widget renders. The builder below is the only producer,
 * so a title, organization name, account id, or raw session id can never reach
 * the widget host. The newest-result label is a translated state word, not a
 * session title. Android has no elapsed timer, so there is no elapsed anchor.
 */
export type AndroidWidgetProps = {
  /**
   * Translated locked copy, drawn only when no counts are. Stale carries both,
   * and the widget then draws the counts; the ongoing notification is the one
   * surface that says the counts are delayed.
   */
  statusLine: string | null;
  /** Every count line in rank order (needs-input, running, idle), zeros included. */
  countLines: AndroidWidgetCount[];
  /** Top-ranked count label; the only row that keeps the foreground color. */
  primaryLabel: string | null;
  /** Kind of the most recent state change; null when no row carried a timestamp. */
  newestResultKind: GlanceableCountKind | null;
  /**
   * Caption of the newest-result footer. Null while no counts show: a locked
   * frame carries one fact, and the caption is the third fact's.
   */
  newestResultTitle: string | null;
  /** The kind label read from `countLines`, never a second spelling of the word. */
  newestResultLabel: string | null;
  /** Preformatted relative time of that change, from the injected formatter. */
  newestResultAgo: string | null;
  /**
   * The reserved slot under the counts: the newest session's title, the
   * in-flight action's progress or failure, or null. Its height is reserved in
   * every size bucket, so a loading→content swap cannot move the count rows.
   * The only copy here that carries user content is a session title, which the
   * snapshot contract keeps out of the snapshot itself (see surface-extras).
   */
  newestLine: string | null;
  actions: AndroidWidgetActions;
  /** Spoken label: status words, counts, then Open agents. Never a title or id. */
  accessibilityLabel: string;
};

/**
 * Resolve the reserved slot's line.
 *
 * The slot is visible on every surface that offers an in-place action — the two
 * count statuses, including an idle-only tray, and the empty one — because a
 * create's progress and failure have nowhere else to appear, and the empty
 * surface and an idle-only tray are the ones that offer `New agent`. The
 * newest-session *title* still draws only where the counts do, so a locked or
 * empty surface never carries a stale title; an action in flight or a failed
 * action owns the slot ahead of the title, so the widget never shows the newest
 * session as if it were the action's result.
 */
function newestLineFor(
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

/** Build the Android widget props from a snapshot, surface flags, and a translator. */
// eslint-disable-next-line max-params -- snapshot, flags, the translator, and the two injected formatters
export function buildAndroidWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String,
  formatAgo: GlanceableAgoFormat = String
): AndroidWidgetProps {
  const status = resolveGlanceableStatus(snapshot, flags);
  const statusKey = glanceableStatusCopyKey(snapshot, flags);
  const showCounts = status === 'happy' || status === 'stale';
  const primary = showCounts ? primaryGlanceableCount(snapshot) : null;
  const countLines = (showCounts ? glanceableCountLines(snapshot) : []).map(line => ({
    label: translate(line.key),
    kind: line.kind,
    count: formatCount(line.count),
  }));
  // The three facts locked frames must not carry: with no counts there is no
  // newest result either, so a waiting or privacy-blanked widget keeps one fact.
  const newestKind = showCounts ? snapshot.newestResultKind : null;
  const newestAt = showCounts ? snapshot.newestResultAt : null;

  const extras = getSurfaceExtras();
  // Android's empty surface is the one that offers `New agent`, so its copy
  // says what that action is about — nothing waiting — instead of the generic
  // no-work copy. Every Android surface resolves its status copy through this
  // mapping (body, spoken label, ongoing notification), so they cannot disagree.
  const androidCopy = (key: string): string =>
    key === 'glanceable.empty' ? translate('glanceable.noneWaiting') : translate(key);

  return {
    statusLine: statusKey === null ? null : androidCopy(statusKey),
    countLines,
    primaryLabel: primary === null ? null : translate(primary.key),
    newestResultKind: newestKind,
    newestResultTitle: showCounts ? translate('glanceable.newestResult') : null,
    newestResultLabel:
      newestKind === null
        ? null
        : (countLines.find(line => line.kind === newestKind)?.label ?? null),
    newestResultAgo: newestKind === null || newestAt === null ? null : formatAgo(newestAt),
    newestLine: newestLineFor(extras, status, translate),
    actions: {
      // Only a permission wait can be answered from the widget, so the button
      // gates on `needsApproval` — the same count as the ongoing notification's
      // Approve action. A `question` needs an answer and a `retry` needs the
      // provider back: neither is approvable, so neither may offer a button the
      // action can only answer by opening the app.
      approve: showCounts && (snapshot.needsApproval ?? 0) > 0,
      newAgent: status === 'empty' || (showCounts && isIdleOnlyGlanceableWork(snapshot)),
      approveLabel: translate('common.approve'),
      newAgentLabel: translate('glanceable.newAgent'),
    },
    accessibilityLabel: glanceableSpokenLabel(snapshot, flags, androidCopy),
  };
}

/** Every redraw checks the data deadline, including a task queued by an older alarm. */
// eslint-disable-next-line max-params -- snapshot, the translator, and the two injected formatters
export function buildCurrentWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat,
  formatAgo: GlanceableAgoFormat
): AndroidWidgetProps {
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (
    (snapshot.status === 'happy' || snapshot.status === 'stale') &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
  ) {
    return buildExpiredWidgetProps(snapshot, translate, formatCount, formatAgo);
  }
  // The Android twin of the iOS stale timeline frame: a redraw past
  // `updatedAt + GLANCEABLE_STALE_MS` stops asserting the counts are current.
  // The counts stay — they are still the last thing the device knew — and only
  // the age goes. The platform's own redraw is what runs this check, so the
  // claim stays honest without the app running. The deadline above wins, so a
  // lapsed snapshot past `expiresAt` still draws the expired frame.
  const staleAt = Date.parse(snapshot.updatedAt) + GLANCEABLE_STALE_MS;
  if (snapshot.status === 'happy' && staleAt <= Date.now()) {
    return buildAndroidWidgetProps(
      { ...snapshot, status: 'stale' },
      {},
      translate,
      formatCount,
      formatAgo
    );
  }
  return buildAndroidWidgetProps(snapshot, {}, translate, formatCount, formatAgo);
}

/** Zero-count expired props: the single future redraw hides counts at expiresAt. */
// eslint-disable-next-line max-params -- snapshot, the translator, and the two injected formatters
function buildExpiredWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat,
  formatAgo: GlanceableAgoFormat
): AndroidWidgetProps {
  return buildAndroidWidgetProps(
    {
      ...snapshot,
      status: 'expired',
      running: 0,
      needsInput: 0,
      idle: 0,
      needsInputSince: null,
    },
    {},
    translate,
    formatCount,
    formatAgo
  );
}

/** Gallery placeholder: empty copy and no counts, with no snapshot behind it. */
export function buildGenericWidgetProps(translate: (key: string) => string): AndroidWidgetProps {
  const empty = translate('glanceable.empty');
  return {
    statusLine: empty,
    countLines: [],
    primaryLabel: null,
    newestResultKind: null,
    newestResultTitle: null,
    newestResultLabel: null,
    newestResultAgo: null,
    newestLine: null,
    // No snapshot means no state to act on: the placeholder offers nothing.
    actions: {
      approve: false,
      newAgent: false,
      approveLabel: translate('common.approve'),
      newAgentLabel: translate('glanceable.newAgent'),
    },
    accessibilityLabel: empty,
  };
}

/**
 * Ongoing notification: every ranked count, with a warning when stale, otherwise
 * the locked status copy. A pending action notice (an approve attempt that has
 * to be retried) prefixes the line, separated by a space because the notice is
 * a full sentence; the compact and promoted surfaces never carry it. Never a
 * title, organization name, or id.
 */
// eslint-disable-next-line max-params -- snapshot, flags, the two injected formatters, and the notice
export function buildOngoingNotificationText(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String,
  notice: string | null = null
): string {
  const status = resolveGlanceableStatus(snapshot, flags);
  if (status === 'happy' || status === 'stale') {
    // A sentence, not a layout: a zero row holds a widget's rows still, but
    // "0 Working" in a notification line is only noise.
    const lines = glanceableCountLines(snapshot).filter(line => line.count > 0);
    if (lines.length > 0) {
      const counts = lines
        .map(line => `${formatCount(line.count)} ${translate(line.key)}`)
        .join(', ');
      const text = status === 'stale' ? `${translate('glanceable.stale')}, ${counts}` : counts;
      return notice === null ? text : `${notice} ${text}`;
    }
  }
  const text = translate(glanceableStatusCopyKey(snapshot, flags) ?? 'glanceable.empty');
  return notice === null ? text : `${notice} ${text}`;
}

/** The promoted chip shows only the primary number; the full text keeps all labels. */
export function buildCompactNotificationText(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  formatCount: GlanceableCountFormat = String
): string | null {
  const status = resolveGlanceableStatus(snapshot, flags);
  if (status !== 'happy' && status !== 'stale') {
    return null;
  }
  const primary = primaryGlanceableCount(snapshot);
  return primary === null ? null : formatCount(primary.count);
}
