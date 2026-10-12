import { type SessionLiveActivityContentState } from '@kilocode/notifications';

import { i18n } from '@/i18n';
import { launcherSessionUrl } from '@/lib/launcher-surfaces';

import { formatGlanceableClock } from './count-format';
import { type SessionNotificationCard } from './session-notification';

/**
 * How one session's content maps to the Android notification's system-template
 * fields (`.specs/mobile-session-live-activity.md` "Android"). The content model
 * is the one shared type, `SessionLiveActivityContentState`, so a field added
 * for iOS renders here too; this file owns the copy and the times.
 */

const LABEL_KEYS = {
  running: 'common.working',
  needsInput: 'glanceable.needsInput',
  scheduled: 'common.scheduled',
  idle: 'glanceable.finished',
  failed: 'common.failed',
} as const satisfies Record<SessionLiveActivityContentState['statusKind'], string>;

function translate(key: string): string {
  return i18n.t(key);
}

/** The localized clock time of one ISO value, or an empty string. */
function clock(value: string | null): string {
  return value === null ? '' : formatGlanceableClock(value);
}

/**
 * The status line under the title. A permission wait names the command the card
 * can answer; a scheduled, finished, or failed card shows the time it is due,
 * finished, or failed; the working line is the label alone, because the elapsed
 * time is the system's counting-up timer.
 */
function statusText(content: SessionLiveActivityContentState): string {
  const label = translate(LABEL_KEYS[content.statusKind]);
  const kind = content.statusKind;
  if (kind === 'running') {
    return label;
  }
  if (kind === 'needsInput') {
    const command = content.permissionCommand ?? '';
    return command.length > 0 ? `${label}: ${command}` : label;
  }
  if (kind === 'scheduled') {
    const at = clock(content.scheduledAt);
    return at.length > 0 ? `${label} ${at}` : label;
  }
  const at = clock(content.statusSince);
  return at.length > 0 ? `${label} ${at}` : label;
}

/** The one short line of a promoted Live Update: the time that fits a chip. */
function chipText(content: SessionLiveActivityContentState): string | null {
  const kind = content.statusKind;
  if (kind === 'running') {
    return null;
  }
  const at = kind === 'scheduled' ? clock(content.scheduledAt) : clock(content.statusSince);
  return at.length > 0 ? at : null;
}

/** The expanded (and promoted) extra line. */
function extraText(content: SessionLiveActivityContentState): string | null {
  const plan = content.plan;
  if (plan !== null && plan !== undefined && plan.total > 0) {
    return `${plan.done}/${plan.total}`;
  }
  const cost = content.costMicrodollars;
  if (cost !== null && cost !== undefined && cost > 0) {
    return `$${(cost / 1_000_000).toFixed(2)}`;
  }
  return null;
}

/** The system-notification card for one content state. */
export function buildSessionNotificationCard(
  content: SessionLiveActivityContentState,
  organizationId: string | null
): SessionNotificationCard {
  const title = (content.title ?? '').trim();
  const running = content.statusKind === 'running';
  const statusSince = Date.parse(content.statusSince);
  const stateAt =
    content.statusKind === 'scheduled' && content.scheduledAt !== null
      ? Date.parse(content.scheduledAt)
      : statusSince;
  const waiting = content.statusKind === 'needsInput';
  const canApprove = waiting && content.awaitingPermission && content.approvalKey !== null;
  return {
    sessionId: content.sessionId,
    organizationId,
    title: title.length > 0 ? title : translate('common.agent'),
    text: statusText(content),
    subText: extraText(content),
    compactText: chipText(content),
    openLabel: translate('glanceable.openSession'),
    openUrl: launcherSessionUrl(content.sessionId),
    approveLabel: canApprove ? translate('common.approve') : null,
    approvalKey: content.approvalKey,
    // A Working card counts up from the last status change on the system clock;
    // a Scheduled card shows its wake time; every other card the time its state
    // began. A card with no usable time shows none.
    whenMs: Number.isFinite(stateAt) ? stateAt : 0,
    showWhen: !running && Number.isFinite(stateAt),
    chronometer: running && Number.isFinite(statusSince),
    promotion: true,
    color: waiting ? '#956011' : '#4F5A10',
  };
}
