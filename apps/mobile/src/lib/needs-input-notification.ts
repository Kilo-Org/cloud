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
 * `needs-input` Android channel, the same `cloud_agent_session` `data`
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
import { resolveSessionDisplayTitle } from '@/lib/session-display-title';
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

/**
 * What the native layer actually did with a plan. A rejected post or dismissal
 * is reported and swallowed, so the caller uses this to keep its notified set
 * honest instead of remembering an operation that never landed.
 */
export type NeedsInputNotificationApplyResult = {
  /** The rows whose post reached the OS. */
  published: NeedsInputNotificationRow[];
  /** The identifiers whose dismissal reached the OS. */
  dismissed: string[];
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
  /**
   * The user's `agentAttention` preference, from the same server-resolved row
   * the Notifications screen edits. The server withholds the attention push
   * when the category is off, so the app-owned carrier must withhold its post
   * too, and dismiss a notification the toggle turned off. `undefined` while the
   * row has not loaded: the plan then neither publishes nor dismisses, because
   * falling back to ON would alert a category the user turned off.
   */
  attentionEnabled: boolean | undefined;
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
    title: resolveSessionDisplayTitle(row.title, i18n.t('agents.sessionRow.untitled')),
    kind,
    prUrl: row.associatedPr?.url ?? null,
    organizationId: row.organizationId ?? null,
  };
}

/**
 * Diff the rows a notification currently stands for (`previous`) against the
 * cached rows after a change (`next`): publish the raises that are not yet
 * notified — or whose action-relevant shape (kind, associated PR) changed while
 * still waiting — dismiss the identifiers whose raise cleared, disappeared, or
 * moved to another organization. A sign-out, or the user's `agentAttention`
 * preference off, dismisses everything and publishes nothing; while that
 * preference has not loaded neither happens, so a restart can never alert a
 * category the user turned off.
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
  attentionEnabled,
}: NeedsInputPlanInput): NeedsInputNotificationPlan {
  const attention = new Map<string, { row: CachedActiveSession; kind: NeedsInputAttentionKind }>();
  for (const row of next) {
    const kind = attentionKindFor(row.status);
    if (kind !== null) {
      attention.set(row.id, { row, kind });
    }
  }

  const signedOut = isSignOutActive();
  // The preference row has not loaded. Posting on the default-ON fallback would
  // alert a category the user turned off, and dismissing on a default-OFF
  // fallback would drop a raise the user still wants, so the plan waits for the
  // row and leaves both the posted set and the notified set untouched.
  if (attentionEnabled === undefined && !signedOut) {
    return { publish: [], dismiss: [] };
  }

  const presentsAttention = !signedOut && attentionEnabled === true;
  const dismiss: string[] = [];
  const alreadyNotified = new Set<string>();
  for (const row of previous) {
    alreadyNotified.add(row.sessionId);
    const current = attention.get(row.sessionId);
    if (
      !presentsAttention ||
      current === undefined ||
      (current.row.organizationId ?? null) !== row.organizationId
    ) {
      dismiss.push(notificationIdentifierForSession(row.sessionId));
    }
  }

  const publish: NeedsInputNotificationRow[] = [];
  if (presentsAttention) {
    for (const [sessionId, { row, kind }] of attention) {
      if (shouldPublishForSession({ appState, pathname, sessionId })) {
        const notifiedRow = alreadyNotified.has(sessionId)
          ? previous.find(previousRow => previousRow.sessionId === sessionId)
          : undefined;
        // An already-notified raise is still waiting under its standing
        // notification. Re-publish in place only when the action-relevant
        // shape changed: the kind moved, or the associated PR appeared or
        // changed. A raise posted before the PR link reached the cache would
        // otherwise never offer Open PR, and a kind flip would keep offering
        // the wrong controls.
        if (
          notifiedRow === undefined ||
          notifiedRow.kind !== kind ||
          (notifiedRow.prUrl ?? null) !== (row.associatedPr?.url ?? null)
        ) {
          publish.push(toNotificationRow(row, kind));
        }
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
 * that owns it. Returns whether the post reached the OS, so the caller does not
 * remember a raise that never appeared.
 */
async function publishRow(row: NeedsInputNotificationRow): Promise<boolean> {
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
    return true;
  } catch (error) {
    reportFailure('publish', error);
    return false;
  }
}

async function dismissIdentifier(identifier: string): Promise<boolean> {
  try {
    await Notifications.dismissNotificationAsync(identifier);
    if (identifier.startsWith(IDENTIFIER_PREFIX)) {
      postedSessions.delete(identifier.slice(IDENTIFIER_PREFIX.length));
    }
    return true;
  } catch (error) {
    reportFailure('dismiss', error);
    return false;
  }
}

/**
 * Apply a plan. Every dismissal is issued before the first post, so a
 * dismiss/publish pair for one identifier ends with the notification posted.
 * Every native call is reported and swallowed, so the returned promise never
 * rejects; the result names the operations that actually landed.
 */
export async function applyNeedsInputNotifications(
  plan: NeedsInputNotificationPlan
): Promise<NeedsInputNotificationApplyResult> {
  const dismissed: string[] = [];
  for (const identifier of plan.dismiss) {
    // eslint-disable-next-line no-await-in-loop -- ordered so a dismiss/publish pair for one identifier ends posted
    if (await dismissIdentifier(identifier)) {
      dismissed.push(identifier);
    }
  }
  const published: NeedsInputNotificationRow[] = [];
  for (const row of plan.publish) {
    // eslint-disable-next-line no-await-in-loop -- ordered so a dismiss/publish pair for one identifier ends posted
    if (await publishRow(row)) {
      published.push(row);
    }
  }
  return { published, dismissed };
}

/** What the caller committed optimistically, paired with the applier's result. */
export type NeedsInputApplyCorrection = {
  plan: NeedsInputNotificationPlan;
  /** Every row the optimistic commit removed from the notified set. */
  dropped: readonly NeedsInputNotificationRow[];
  result: NeedsInputNotificationApplyResult;
};

/**
 * Correct the caller's optimistically committed notified set with what the
 * native layer actually did. The caller commits the whole plan before the
 * native calls resolve, so an immediate re-plan does not re-post what is
 * already on its way; this undoes the operations that failed so the next plan
 * retries them.
 *
 * A failed dismissal is put back: its notification is still on screen. A failed
 * post is dropped, and — because a re-publish replaces its previous row under the
 * same identifier — the previous row comes back instead when the post never
 * landed: the old notification is still on screen, and the memory has to keep
 * the row so a later plan where the raise clears can dismiss it. A failed
 * brand-new raise had no previous row, so nothing is restored. A later plan's
 * row for the same session is matched by identity, never dropped here.
 */
export function reconcileNotifiedAfterApply(
  notified: readonly NeedsInputNotificationRow[],
  correction: NeedsInputApplyCorrection
): NeedsInputNotificationRow[] {
  const { plan, dropped, result } = correction;
  const dismissed = new Set(result.dismissed);
  const published = new Set(result.published);
  // The exact rows this plan posted that never reached the OS.
  const failedPosts = new Set(plan.publish.filter(row => !published.has(row)));
  const failedPublishSessionIds = new Set([...failedPosts].map(row => row.sessionId));
  const kept = notified.filter(row => !failedPosts.has(row));
  const restored = dropped.filter(row => {
    const identifier = notificationIdentifierForSession(row.sessionId);
    if (dismissed.has(identifier)) {
      return false;
    }
    if (kept.some(current => current.sessionId === row.sessionId)) {
      return false;
    }
    return plan.dismiss.includes(identifier) || failedPublishSessionIds.has(row.sessionId);
  });
  return [...restored, ...kept];
}
