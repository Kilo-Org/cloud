import {
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  type GlanceableCountKind,
  glanceableCountLines,
  glanceableSpokenLabel,
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
 * The two in-place actions a state offers, plus the translated row labels the
 * widget host draws. A disabled action's label is still carried so the widget
 * never composes copy of its own.
 */
type AndroidWidgetActions = {
  /** A session is waiting: the widget can answer its permission in place. */
  approve: boolean;
  /** Nothing is eligible: the widget can start a new agent in place. */
  newAgent: boolean;
  approveLabel: string;
  newAgentLabel: string;
};

/**
 * The props the Android widget renders. The builder below is the only producer,
 * so a title, organization name, account id, or raw session id can never reach
 * the widget host. Android has no elapsed timer, so there is no elapsed anchor.
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
 * Resolve the reserved slot's line. The slot renders only where the counts do,
 * so a blank or loading surface never shows a stale title or a failure line; an
 * action in flight or a failed approve then owns the slot, so the widget never
 * shows the newest session as if it were the action's result.
 */
function newestLineFor(
  extras: GlanceableSurfaceExtras,
  showCounts: boolean,
  translate: (key: string) => string
): string | null {
  if (!showCounts) {
    return null;
  }
  if (extras.actionFeedback === 'approving') {
    return translate('glanceable.approving');
  }
  if (extras.actionFeedback === 'couldNotApprove') {
    return translate('glanceable.couldNotApprove');
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
// eslint-disable-next-line max-params -- snapshot, flags, and the two injected formatters
export function buildAndroidWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String
): AndroidWidgetProps {
  const status = resolveGlanceableStatus(snapshot, flags);
  const statusKey = glanceableStatusCopyKey(snapshot, flags);
  const showCounts = status === 'happy' || status === 'stale';
  const primary = showCounts ? primaryGlanceableCount(snapshot) : null;
  const extras = getSurfaceExtras();
  // Android's empty surface is the one that offers `New agent`, so its copy
  // says what that action is about — nothing waiting — instead of the generic
  // no-work copy. Every Android surface resolves its status copy through this
  // mapping (body, spoken label, ongoing notification), so they cannot disagree.
  const androidCopy = (key: string): string =>
    key === 'glanceable.empty' ? translate('glanceable.noneWaiting') : translate(key);

  return {
    statusLine: statusKey === null ? null : androidCopy(statusKey),
    countLines: (showCounts ? glanceableCountLines(snapshot) : []).map(line => ({
      label: translate(line.key),
      kind: line.kind,
      count: formatCount(line.count),
    })),
    primaryLabel: primary === null ? null : translate(primary.key),
    newestLine: newestLineFor(extras, showCounts, translate),
    actions: {
      approve: showCounts && snapshot.needsInput > 0,
      newAgent: status === 'empty' || (showCounts && !isEligibleGlanceableWork(snapshot)),
      approveLabel: translate('common.approve'),
      newAgentLabel: translate('glanceable.newAgent'),
    },
    accessibilityLabel: glanceableSpokenLabel(snapshot, flags, androidCopy),
  };
}

/** Every redraw checks the data deadline, including a task queued by an older alarm. */
export function buildCurrentWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String
): AndroidWidgetProps {
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (
    (snapshot.status === 'happy' || snapshot.status === 'stale') &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
  ) {
    return buildExpiredWidgetProps(snapshot, translate, formatCount);
  }
  return buildAndroidWidgetProps(snapshot, {}, translate, formatCount);
}

/** Zero-count expired props: the single future redraw hides counts at expiresAt. */
function buildExpiredWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat
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
    formatCount
  );
}

/** Gallery placeholder: empty copy and no counts, with no snapshot behind it. */
export function buildGenericWidgetProps(translate: (key: string) => string): AndroidWidgetProps {
  const empty = translate('glanceable.empty');
  return {
    statusLine: empty,
    countLines: [],
    primaryLabel: null,
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
 * the locked status copy. Never a title, organization name, or id.
 */
// eslint-disable-next-line max-params -- snapshot, flags, and the two injected formatters
export function buildOngoingNotificationText(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String
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
      return status === 'stale' ? `${translate('glanceable.stale')}, ${counts}` : counts;
    }
  }
  return translate(glanceableStatusCopyKey(snapshot, flags) ?? 'glanceable.empty');
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
