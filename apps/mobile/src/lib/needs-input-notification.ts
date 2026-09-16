/**
 * App-owned needs-input notifications.
 *
 * The live socket carries a raise (`status: 'question' | 'permission'`) faster
 * than any push, and the server suppresses its own push while the user is
 * looking at that session (presence). So while the app is foregrounded and the
 * raise is not already on screen, the app posts the notification itself: a
 * real, app-owned, actionable notification exists even where no push can be
 * delivered.
 *
 * Both carriers must land on one OS notification, so the app posts under the
 * shared contract: the same `kilo-needs-input:*` category id, the same
 * `agent-attention` Android channel, the same `cloud_agent_session` `data`
 * payload the push carries, and the same iOS interruption level. That is also
 * why the plan is keyed on a stable per-session identifier — a later plan for
 * the same session replaces the notification instead of stacking a second one.
 *
 * Everything here uses `expo-notifications` APIs that behave identically on
 * both platforms: the Android channel comes from the shared channel contract
 * and the iOS interruption level from the same content field, so there is no
 * `Platform.OS` branch and no `.ios.`/`.android.` split.
 *
 * `planNeedsInputNotifications` is pure. `previous` is the caller's notified
 * set — the rows whose notification is currently posted — so a re-plan (on a
 * rows change or a route change) can tell a row that just raised from one that
 * was already raised, never re-posts a notification that is already on screen,
 * and still knows what to dismiss after a plan that publishes nothing. The
 * caller carries it forward as `previous - dismiss + publish`.
 */

import * as Notifications from 'expo-notifications';
import { type AppStateStatus } from 'react-native';

import {
  androidChannelIdForPushData,
  needsInputCategoryId,
  type PushData,
} from '@kilocode/notifications';

import { type CachedActiveSession, isAttentionStatus } from '@/lib/active-sessions-live';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { captureTelemetry } from '@/lib/telemetry/error-sink';
import { i18n } from '@/i18n';

/** The two raise kinds a cached row can be in. */
type NeedsInputAttentionKind = 'question' | 'permission';

/** One published notification, as the next plan remembers it. */
export type NeedsInputNotificationRow = {
  sessionId: string;
  title: string;
  kind: NeedsInputAttentionKind;
  prUrl: string | null;
  organizationId: string | null;
};

export type NeedsInputNotificationPlan = {
  publish: NeedsInputNotificationRow[];
  /** Identifiers to dismiss, derived from the session id. */
  dismiss: string[];
};

export type NeedsInputPlanInput = {
  /**
   * The rows whose notification is currently posted — the notified set the
   * caller carries forward as `previous - dismiss + publish`; empty on the
   * first plan. A row that left needs-input or disappeared is no longer in
   * `next`, so its identifier is dismissed; a row still present under another
   * organization is dismissed and never re-posted under the old context. A
   * still-waiting row stays in the set even when the gate withholds its post.
   */
  previous: readonly NeedsInputNotificationRow[];
  /** The cached active-session rows after the change. */
  next: readonly CachedActiveSession[];
  /** Route from `usePathname()`; null when the router is not mounted. */
  pathname: string | null;
  /** `AppState.currentState` at plan time. */
  appState: AppStateStatus;
};

/** The identifier a session's needs-input notification is posted and replaced under. */
export function notificationIdentifierForSession(kiloSessionId: string): string {
  return `needs-input:${kiloSessionId}`;
}

const IDENTIFIER_PREFIX = 'needs-input:';

/**
 * True when a notification request identifier belongs to the app's own
 * needs-input post. The foreground handler reads it so it can suppress the
 * server's attention push without suppressing the app's own notification,
 * which carries the same parsed payload (both must dispatch the same actions).
 */
export function isAppOwnedNeedsInputNotification(identifier: string | null | undefined): boolean {
  return (identifier ?? '').startsWith(IDENTIFIER_PREFIX);
}

// The sessions whose app-owned needs-input notification is currently posted.
// In-memory like the mount's notified set: a fresh process posts nothing until
// the cached rows raise again, so a restart can only under-report (a duplicate
// server push may show once), never suppress a raise that has no notification.
const postedSessions = new Set<string>();

/**
 * Whether the app's own needs-input notification for this session is currently
 * on screen. Read by the foreground handler to suppress the server's attention
 * push — the app's notification is already the presentation.
 */
export function isNeedsInputNotificationPosted(kiloSessionId: string): boolean {
  return postedSessions.has(kiloSessionId);
}

/** Drop the posted marker once the raise's presentation is gone (result or dismissal). */
export function clearPostedNeedsInputNotification(kiloSessionId: string): void {
  postedSessions.delete(kiloSessionId);
}

/** The raise kind, or null when the row is not waiting for input. */
function attentionKindFor(status: string | null | undefined): NeedsInputAttentionKind | null {
  if (!isAttentionStatus(status)) {
    return null;
  }
  return status === 'permission' ? 'permission' : 'question';
}

/** Path segments, so group segments like `(app)` and a query string are ignored. */
function pathSegments(pathname: string): string[] {
  const [path = ''] = pathname.split('?');
  return path
    .split('/')
    .filter(Boolean)
    .filter(segment => !(segment.startsWith('(') && segment.endsWith(')')));
}

/**
 * True when the app, not the server push, must present this session's raise: the
 * app is foregrounded, and the user is not already on that session's chat. The
 * server suppresses its push by presence while the session is being viewed, so
 * the open chat is the one case where neither carrier may duplicate the in-app
 * question card.
 */
export function shouldPublishForSession({
  appState,
  pathname,
  sessionId,
}: {
  appState: AppStateStatus;
  pathname: string | null;
  sessionId: string;
}): boolean {
  if (appState !== 'active') {
    return false;
  }
  if (pathname === null) {
    return true;
  }
  const segments = pathSegments(pathname);
  return !(segments.length === 2 && segments[0] === 'agent-chat' && segments[1] === sessionId);
}

function toNotificationRow(
  row: CachedActiveSession,
  kind: NeedsInputAttentionKind
): NeedsInputNotificationRow {
  return {
    sessionId: row.id,
    title: row.title,
    kind,
    prUrl: row.associatedPr?.url ?? null,
    organizationId: row.organizationId ?? null,
  };
}

/**
 * Diff the rows a notification currently stands for (`previous`) against the
 * cached rows after a change (`next`): publish the raises that are not yet
 * notified, dismiss the identifiers whose raise cleared, disappeared, or moved
 * to another organization. A sign-out dismisses everything and publishes
 * nothing.
 *
 * A raise that is still waiting is never dismissed merely because the app is
 * backgrounded or its chat is open — the gate only withholds the post, so the
 * notification already on screen survives a foreground/route change.
 */
export function planNeedsInputNotifications({
  previous,
  next,
  pathname,
  appState,
}: NeedsInputPlanInput): NeedsInputNotificationPlan {
  const attention = new Map<string, { row: CachedActiveSession; kind: NeedsInputAttentionKind }>();
  for (const row of next) {
    const kind = attentionKindFor(row.status);
    if (kind !== null) {
      attention.set(row.id, { row, kind });
    }
  }

  const signedOut = isSignOutActive();
  const dismiss: string[] = [];
  const alreadyNotified = new Set<string>();
  for (const row of previous) {
    alreadyNotified.add(row.sessionId);
    const current = attention.get(row.sessionId);
    if (
      signedOut ||
      current === undefined ||
      (current.row.organizationId ?? null) !== row.organizationId
    ) {
      dismiss.push(notificationIdentifierForSession(row.sessionId));
    }
  }

  const publish: NeedsInputNotificationRow[] = [];
  if (!signedOut) {
    for (const [sessionId, { row, kind }] of attention) {
      if (
        !alreadyNotified.has(sessionId) &&
        shouldPublishForSession({ appState, pathname, sessionId })
      ) {
        publish.push(toNotificationRow(row, kind));
      }
    }
  }

  return { publish, dismiss };
}

/** The push `data` a posted raise carries, matching the server's attention push. */
function pushDataForRow(
  row: NeedsInputNotificationRow
): Extract<PushData, { type: 'cloud_agent_session' }> {
  return {
    type: 'cloud_agent_session',
    cliSessionId: row.sessionId,
    category: 'attention',
    attentionKind: row.kind,
    ...(row.prUrl === null ? {} : { prUrl: row.prUrl }),
  };
}

function reportFailure(operation: 'publish' | 'dismiss', error: unknown): void {
  captureTelemetry({
    level: 'warning',
    error,
    tags: {
      'error.subsystem': 'notifications',
      'error.operation': `needs_input_${operation}`,
    },
  });
}

/**
 * Post one raise. A rejected schedule (the permission was revoked after login)
 * is reported and swallowed: the app-owned carrier must never crash the mount
 * that owns it.
 */
async function publishRow(row: NeedsInputNotificationRow): Promise<void> {
  const data = pushDataForRow(row);
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: notificationIdentifierForSession(row.sessionId),
      content: {
        title: row.title,
        body: i18n.t('agentChat.questionCard.title'),
        data,
        categoryIdentifier: needsInputCategoryId({ kind: row.kind, hasPr: row.prUrl !== null }),
        interruptionLevel: 'timeSensitive',
      },
      // A channel-aware trigger delivers immediately on both platforms: Android
      // routes to the shared attention channel, iOS reads it as a null trigger.
      trigger: { channelId: androidChannelIdForPushData(data) },
    });
    postedSessions.add(row.sessionId);
  } catch (error) {
    reportFailure('publish', error);
  }
}

async function dismissIdentifier(identifier: string): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(identifier);
    if (identifier.startsWith(IDENTIFIER_PREFIX)) {
      postedSessions.delete(identifier.slice(IDENTIFIER_PREFIX.length));
    }
  } catch (error) {
    reportFailure('dismiss', error);
  }
}

/**
 * Apply a plan. Every dismissal is issued before the first post, so a
 * dismiss/publish pair for one identifier ends with the notification posted.
 * Every native call is reported and swallowed, so the returned promise never
 * rejects.
 */
export async function applyNeedsInputNotifications(
  plan: NeedsInputNotificationPlan
): Promise<void> {
  for (const identifier of plan.dismiss) {
    // eslint-disable-next-line no-await-in-loop -- ordered so a dismiss/publish pair for one identifier ends posted
    await dismissIdentifier(identifier);
  }
  for (const row of plan.publish) {
    // eslint-disable-next-line no-await-in-loop -- ordered so a dismiss/publish pair for one identifier ends posted
    await publishRow(row);
  }
}
