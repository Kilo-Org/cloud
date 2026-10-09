import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  glanceableCountLines,
  glanceableScheduledAt,
  glanceableStatusCopyKey,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';

import { type GlanceableClockFormat, type GlanceableCountFormat } from './home-copy';

/**
 * The ongoing notification's system-template content (round 8). It is visible
 * on the lock screen, so it carries counts, status and times only: never an
 * agent title, a session id or an organization.
 */
export type OngoingNotificationContent = {
  /** "<count> <status>" for the ranked primary count, or the status line. */
  title: string;
  /** The other counts, "Next run <time>" for scheduled-only, "Approving…", or the retry line. */
  text: string;
  /** Draws `text` as the failed-approve retry line. */
  textIsError: boolean;
  /** "Checked <time>", or "Last known · <time>" while the data is stale. */
  subText: string | null;
  /** The promoted chip: the primary count, or the run time when only a wake is scheduled. */
  compactText: string | null;
  /** Working cards offer New agent; waiting, scheduled and stale ones do not. */
  offersNewAgent: boolean;
};

export type NotificationFormat = {
  translate: (key: string) => string;
  formatCount: GlanceableCountFormat;
  formatClock: GlanceableClockFormat;
};

/** What the approve flow is doing to the card: nothing, in flight, or failed with its line. */
export type NotificationAction = { approving: boolean; failure: string | null };

function checkedLine(
  snapshot: GlanceableAgentsSnapshot,
  format: NotificationFormat
): string | null {
  if (!Number.isFinite(Date.parse(snapshot.updatedAt))) {
    return null;
  }
  const at = format.formatClock(snapshot.updatedAt);
  return snapshot.status === 'stale'
    ? `${format.translate('glanceable.lastKnown')} · ${at}`
    : `${format.translate('glanceable.checked')} ${at}`;
}

export function buildOngoingNotificationContent(
  snapshot: GlanceableAgentsSnapshot,
  format: NotificationFormat,
  action: NotificationAction
): OngoingNotificationContent {
  const { translate, formatCount, formatClock } = format;
  const status = resolveGlanceableStatus(snapshot);
  const primary =
    status === 'happy' || status === 'stale' ? primaryGlanceableCount(snapshot) : null;
  if (primary === null) {
    return {
      title: translate(glanceableStatusCopyKey(snapshot) ?? 'glanceable.empty'),
      text: '',
      textIsError: false,
      subText: null,
      compactText: null,
      offersNewAgent: false,
    };
  }
  const others = glanceableCountLines(snapshot)
    .filter(line => line.kind !== primary.kind && line.count > 0)
    .map(line => `${formatCount(line.count)} ${translate(line.key)}`)
    .join(' · ');
  const scheduledAt = glanceableScheduledAt(snapshot);
  const wakeOnly = primary.kind === 'scheduled' && others === '' && scheduledAt !== null;
  let text = wakeOnly ? `${translate('glanceable.nextRun')} ${formatClock(scheduledAt)}` : others;
  if (action.failure !== null) {
    text = action.failure;
  } else if (action.approving) {
    text = translate('glanceable.approving');
  }
  return {
    title: `${formatCount(primary.count)} ${translate(primary.key)}`,
    text,
    textIsError: action.failure !== null,
    subText: checkedLine(snapshot, format),
    compactText: wakeOnly ? formatClock(scheduledAt) : formatCount(primary.count),
    offersNewAgent: primary.kind === 'running' && snapshot.status !== 'stale',
  };
}

/** A terminal card (work just ended): the status line alone until the native timeout. */
export function terminalNotificationContent(title: string): OngoingNotificationContent {
  return {
    title,
    text: '',
    textIsError: false,
    subText: null,
    compactText: null,
    offersNewAgent: false,
  };
}
