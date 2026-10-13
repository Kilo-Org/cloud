import {
  SESSION_CARD_QUIET_AFTER_MS,
  type SessionLiveActivityContentState,
} from '@kilocode/notifications';

import { formatSessionTotalCost } from '@/components/agents/session-list-helpers';
import { i18n } from '@/i18n';
import { launcherSessionUrl } from '@/lib/launcher-surfaces';

import { formatGlanceableClock, formatGlanceableCount } from './count-format';
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

const FAILURE_KEYS = {
  provider: 'glanceable.failure.provider',
  tool: 'glanceable.failure.tool',
  cancelled: 'glanceable.failure.cancelled',
  other: 'glanceable.failure.other',
} as const;

/** The status line separator the aggregate card uses too. */
const SEPARATOR = ' · ';

function translate(key: string): string {
  return i18n.t(key);
}

/** The localized clock time of one ISO value, or an empty string. */
function clock(value: string | null): string {
  return value === null ? '' : formatGlanceableClock(value);
}

/** The label, then the absolute time when one is known. */
function withTime(label: string, at: string): string {
  return at.length > 0 ? `${label} ${at}` : label;
}

/**
 * The label of the state. A failed card names its stop reason instead of the
 * bare "Failed" (spec "Content" rule 3).
 */
function statusLabel(content: SessionLiveActivityContentState): string {
  if (content.statusKind === 'failed') {
    return translate(FAILURE_KEYS[content.failure?.kind ?? 'other']);
  }
  return translate(LABEL_KEYS[content.statusKind]);
}

/**
 * The status line under the title. Every card except Working names the
 * absolute time of its state in the text: the wait start, the wake time, the
 * finish, or the stop. The system header time is hidden for those cards,
 * because it draws a relative age ("4m"), which the glanceable design rules
 * forbid. A permission wait then names the command the card can answer. The
 * Working line is the label alone, because the elapsed time is the system's
 * counting-up timer.
 */
function statusText(content: SessionLiveActivityContentState): string {
  const label = statusLabel(content);
  const kind = content.statusKind;
  if (kind === 'running') {
    return label;
  }
  if (kind === 'scheduled') {
    return withTime(label, clock(content.scheduledAt));
  }
  const line = withTime(label, clock(content.statusSince));
  const command = kind === 'needsInput' ? (content.permissionCommand ?? '') : '';
  return command.length > 0 ? `${line}${SEPARATOR}${command}` : line;
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

/** The plan count ("3 of 7") in the app language's digits, or null. */
function planText(content: SessionLiveActivityContentState): string | null {
  const plan = content.plan;
  if (plan === null || plan === undefined || plan.total <= 0) {
    return null;
  }
  return [
    formatGlanceableCount(plan.done),
    translate('glanceable.planOf'),
    formatGlanceableCount(plan.total),
  ].join(' ');
}

type QuietFields = Pick<
  SessionNotificationCard,
  'text' | 'whenMs' | 'quietAtMs' | 'quietWhenMs' | 'quietText'
>;

/**
 * The quiet warning of a Working card (spec "Content" rule 7). The card has one
 * system timer. Until the quiet window passes it counts the time since the
 * last status change; once the agent has reported no activity for the window,
 * the text names the warning and the timer counts the quiet time from the last
 * activity, so the warning stays right while no process runs. A card that is
 * not quiet yet carries the quiet form and the moment it applies, and the
 * native side swaps to it at that moment without a push.
 */
function quietFields(content: SessionLiveActivityContentState, now: number): QuietFields {
  const text = statusText(content);
  const plain = {
    text,
    whenMs: Date.parse(content.statusSince),
    quietAtMs: 0,
    quietWhenMs: 0,
    quietText: null,
  };
  const lastActivity =
    content.lastActivityAt === null || content.lastActivityAt === undefined
      ? Number.NaN
      : Date.parse(content.lastActivityAt);
  if (content.statusKind !== 'running' || !Number.isFinite(lastActivity)) {
    return plain;
  }
  const quietText = `${text}${SEPARATOR}${translate('glanceable.noActivityFor')}`;
  const quietAt = lastActivity + SESSION_CARD_QUIET_AFTER_MS;
  if (now >= quietAt) {
    return { ...plain, text: quietText, whenMs: lastActivity };
  }
  return { ...plain, quietAtMs: quietAt, quietWhenMs: lastActivity, quietText };
}

/** The system-notification card for one content state. */
export function buildSessionNotificationCard(
  content: SessionLiveActivityContentState,
  organizationId: string | null,
  now: number = Date.now()
): SessionNotificationCard {
  const title = (content.title ?? '').trim();
  const statusSince = Date.parse(content.statusSince);
  const stateAt =
    content.statusKind === 'scheduled' && content.scheduledAt !== null
      ? Date.parse(content.scheduledAt)
      : statusSince;
  const waiting = content.statusKind === 'needsInput';
  const canApprove = waiting && content.awaitingPermission && content.approvalKey !== null;
  const timed = content.statusKind === 'running' && Number.isFinite(statusSince);
  return {
    sessionId: content.sessionId,
    organizationId,
    title: title.length > 0 ? title : translate('common.agent'),
    subText: planText(content),
    // The cost so far, by the app's one cost rule: a small cost is exact or
    // absent, never a false zero. It goes only to the expanded part of the
    // notification (spec "Android: the notification" rule 5).
    expandedText: formatSessionTotalCost(content.costMicrodollars),
    compactText: chipText(content),
    openLabel: translate('glanceable.openSession'),
    openUrl: launcherSessionUrl(content.sessionId),
    approveLabel: canApprove ? translate('common.approve') : null,
    approvalKey: content.approvalKey,
    ...(timed
      ? quietFields(content, now)
      : {
          text: statusText(content),
          whenMs: Number.isFinite(stateAt) ? stateAt : 0,
          quietAtMs: 0,
          quietWhenMs: 0,
          quietText: null,
        }),
    chronometer: timed,
    promotion: true,
    color: waiting ? '#956011' : '#4F5A10',
  };
}
