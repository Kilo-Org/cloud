import { GLANCEABLE_STALE_MS } from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  buildSessionLiveActivityContentState,
  sessionLiveActivityRelevance,
  type SessionLiveActivityRow,
} from '@kilocode/notifications';
import { after, type LiveActivity } from 'expo-widgets';

import {
  getLiveActivityEnabled,
  getNotificationPermissionGranted,
} from '@/lib/glanceable/live-activity-switch';
import {
  registerSessionActivityToken,
  releaseSessionActivity,
  retrySessionActivityTokens,
} from '@/lib/glanceable/session-activity-tokens';
import { getGlanceableDelivery } from '@/lib/glanceable/sink-registry';
import { launcherSessionUrl } from '@/lib/launcher-surfaces';

import { SessionLiveActivity, type SessionLiveActivityProps } from './session-live-activity';
import { liveActivitiesAllowedBySystem } from './system-switch';

/**
 * The session cards this device follows (`.specs/mobile-session-live-activity.md`).
 *
 * A card starts only from Follow, in this process. The server updates and ends
 * it by push after that; while the app is in the foreground, the tray rows
 * update it locally too (`syncFollowedSessionCards`). Native discovery is the
 * source of truth: a card outlives the process that started it, and its
 * session id travels in its content state, so every launch rebuilds the map
 * from `getInstances`.
 *
 * Only `SessionLiveActivity` instances are read or ended here. The aggregate
 * card's sink reads `ActiveAgentsLiveActivity` instances only, and expo-widgets
 * filters each factory's instances by name, so neither cleanup can end the
 * other's cards.
 */

export type SessionActivity = LiveActivity<SessionLiveActivityProps>;

export type SessionFollowContext = { userId: string; organizationId: string | null };

export type FollowResult = 'started' | 'followed' | 'refused';

/** ActivityKit takes the stale window in seconds. */
const STALE_AFTER_SECONDS = GLANCEABLE_STALE_MS / 1000;

/** A finished card stays on the Lock Screen this long (spec "Ending" rule 1). */
export const SESSION_FINISHED_DISMISS_MS = 15 * 60 * 1000;

/** The visible card of each followed session. */
const cards = new Map<string, SessionActivity>();
/** The in-flight Approve press or its failure line, by session id. */
const presses = new Map<string, Pick<SessionLiveActivityProps, 'approving' | 'notice'>>();
const listeners = new Set<() => void>();
let revision = 0;

function emit(): void {
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeSessionFollows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes on every follow, unfollow, and discovery that changed the map. */
export function getSessionFollowsRevision(): number {
  return revision;
}

export function isSessionFollowed(sessionId: string): boolean {
  return cards.has(sessionId);
}

function isLive(activity: SessionActivity): boolean {
  const { state } = activity.getInfo();
  return state === 'active' || state === 'stale';
}

/** Every native session card, or none when ActivityKit cannot be read. */
function readInstances(includeEnded: boolean): SessionActivity[] {
  try {
    return SessionLiveActivity.getInstances(includeEnded);
  } catch {
    return [];
  }
}

async function readToken(activity: SessionActivity): Promise<string | null> {
  try {
    return await activity.getPushToken();
  } catch {
    return null;
  }
}

/**
 * End one card and release its push token on the server. The token read starts
 * before the end, because ActivityKit drops the token with the card.
 */
function endCard(
  activity: SessionActivity,
  dismissal: 'immediate' | { after: Date },
  props?: SessionLiveActivityProps
): void {
  const token = readToken(activity);
  releaseSessionActivity(activity.getId());
  getGlanceableDelivery().cleanupTokens('session', token);
  const relevance =
    props?.statusKind === undefined ? undefined : sessionLiveActivityRelevance(props.statusKind);
  void activity.end(dismissal, props, new Date(), relevance).catch(() => {
    // An end for a card iOS already removed has nothing left to do.
  });
}

/**
 * Rebuild the map from native truth. A second live card for one session is a
 * duplicate (spec "Starting" rule 3), so it ends at once.
 */
export function discoverSessionCards(): SessionActivity[] {
  const next = new Map<string, SessionActivity>();
  for (const activity of readInstances(false)) {
    const sessionId = activity.getProps()?.sessionId;
    if (sessionId === undefined || sessionId.length === 0) {
      // A card with no session cannot route or be updated by the server.
      endCard(activity, 'immediate');
    } else if (next.has(sessionId)) {
      endCard(activity, 'immediate');
    } else {
      next.set(sessionId, activity);
    }
  }
  const changed =
    next.size !== cards.size ||
    [...next].some(([sessionId, activity]) => cards.get(sessionId)?.getId() !== activity.getId());
  cards.clear();
  for (const [sessionId, activity] of next) {
    cards.set(sessionId, activity);
  }
  if (changed) {
    emit();
  }
  return [...next.values()];
}

/**
 * Launch and foreground: rebuild the map, then register every card's token
 * again. A registration that failed earlier retries here (spec "Error
 * Handling" rule 4). Without a known account the cards stay as they are: a
 * locked keychain is not a sign-out, and sign-out ends the cards itself.
 */
export function restoreFollowedSessionCards(ctx: SessionFollowContext | null): void {
  if (!getLiveActivityEnabled()) {
    // The in-app switch turned off while no process ran: no card may stay.
    endAllSessionCards();
    return;
  }
  const live = discoverSessionCards();
  if (ctx === null) {
    return;
  }
  for (const activity of live) {
    const sessionId = activity.getProps()?.sessionId;
    if (sessionId !== undefined) {
      registerSessionActivityToken(activity.getId(), activity, { sessionId, ...ctx });
    }
  }
  retrySessionActivityTokens();
}

/**
 * Follow one session: start its card collapsed and silent, from the row the
 * session screen shows. Returns `refused` when iOS or the user's switches do
 * not allow a card, so the caller can say so; the session then stays
 * unfollowed and the aggregate card keeps counting it.
 */
export function followSession(
  row: SessionLiveActivityRow,
  ctx: SessionFollowContext,
  now: number = Date.now()
): FollowResult {
  discoverSessionCards();
  if (cards.has(row.id)) {
    return 'followed';
  }
  const at = new Date(now).toISOString();
  const content = buildSessionLiveActivityContentState(row, {
    // The tray row carries no approval key; the server's first push adds it.
    approvalKey: null,
    updatedAt: at,
    statusSinceFallback: at,
  });
  if (
    content.statusKind === 'idle' ||
    !getLiveActivityEnabled() ||
    !getNotificationPermissionGranted() ||
    !liveActivitiesAllowedBySystem()
  ) {
    return 'refused';
  }
  let activity: SessionActivity;
  try {
    activity = SessionLiveActivity.start(
      content,
      launcherSessionUrl(row.id),
      STALE_AFTER_SECONDS,
      sessionLiveActivityRelevance(content.statusKind)
    );
  } catch {
    // Live Activities off in Settings, or the system limit of activities.
    return 'refused';
  }
  cards.set(row.id, activity);
  registerSessionActivityToken(activity.getId(), activity, { sessionId: row.id, ...ctx });
  emit();
  return 'started';
}

/** Unfollow: end the card at once and release its token. */
export function unfollowSession(sessionId: string): void {
  const activity = cards.get(sessionId);
  if (activity === undefined) {
    return;
  }
  cards.delete(sessionId);
  presses.delete(sessionId);
  endCard(activity, 'immediate');
  emit();
}

/**
 * Opening a session dismisses its finished card at once (spec "Ending" rule 1).
 * A live card stays: the user still follows that session.
 */
export function dismissFinishedSessionCard(sessionId: string): void {
  for (const activity of readInstances(true)) {
    const props = activity.getProps();
    if (props?.sessionId === sessionId && (!isLive(activity) || props.statusKind === 'idle')) {
      if (cards.get(sessionId)?.getId() === activity.getId()) {
        cards.delete(sessionId);
        emit();
      }
      endCard(activity, 'immediate');
    }
  }
}

/**
 * End every session card at once: sign-out, an account change, an organization
 * switch, a lost organization, and the in-app switch turned off (spec "Ending"
 * rule 3). Every caller also retires the whole token scope, which deletes the
 * session card tokens with it before the device session is revoked, so this
 * only ends the native cards.
 */
export function endAllSessionCards(): void {
  for (const activity of readInstances(true)) {
    releaseSessionActivity(activity.getId());
    void activity.end('immediate').catch(() => {
      // An end for a card iOS already removed has nothing left to do.
    });
  }
  presses.clear();
  if (cards.size > 0) {
    cards.clear();
    emit();
  }
}

/** The facts the card draws; a change in anything else is not an update (spec "Updates" rule 2). */
function drawsSame(a: SessionLiveActivityProps | null, b: SessionLiveActivityProps): boolean {
  return (
    a !== null &&
    a.title === b.title &&
    a.statusKind === b.statusKind &&
    a.statusSince === b.statusSince &&
    a.scheduledAt === b.scheduledAt &&
    a.awaitingPermission === b.awaitingPermission &&
    a.approvalKey === b.approvalKey
  );
}

/**
 * Update the followed cards from the foreground tray rows. A finished session
 * ends its card with the Finished content, kept on the Lock Screen for 15
 * minutes. A session missing from the rows is left to the server, which knows
 * whether it was deleted or only left the tray.
 */
export function syncFollowedSessionCards(
  rows: readonly SessionLiveActivityRow[],
  checkedAt: number = Date.now()
): void {
  if (cards.size === 0) {
    return;
  }
  const updatedAt = new Date(checkedAt > 0 ? checkedAt : Date.now()).toISOString();
  let ended = false;
  for (const [sessionId, activity] of cards) {
    const row = rows.find(candidate => candidate.id === sessionId);
    const current = activity.getProps();
    if (row !== undefined && isLive(activity)) {
      const content = buildSessionLiveActivityContentState(row, {
        // A pushed key names the request the server saw; Approve revalidates it.
        approvalKey: current?.approvalKey ?? null,
        updatedAt,
        statusSinceFallback: current?.statusSince ?? updatedAt,
      });
      if (content.statusKind === 'idle') {
        cards.delete(sessionId);
        presses.delete(sessionId);
        ended = true;
        endCard(activity, after(new Date(Date.now() + SESSION_FINISHED_DISMISS_MS)), content);
      } else if (!drawsSame(current, content)) {
        void activity
          .update(
            { ...content, ...presses.get(sessionId) },
            STALE_AFTER_SECONDS,
            sessionLiveActivityRelevance(content.statusKind)
          )
          .catch(() => {
            // The next foreground or push corrects the card.
          });
      }
    }
  }
  if (ended) {
    emit();
  }
}

/** Live counts by status kind of the followed sessions, for the aggregate card. */
export function followedSessionCounts(): {
  running: number;
  needsInput: number;
  needsApproval: number;
  idle: number;
  scheduled: number;
} {
  const counts = { running: 0, needsInput: 0, needsApproval: 0, idle: 0, scheduled: 0 };
  for (const activity of cards.values()) {
    const props = isLive(activity) ? activity.getProps() : null;
    if (props?.statusKind !== undefined) {
      counts[props.statusKind] += 1;
      if (props.awaitingPermission === true) {
        counts.needsApproval += 1;
      }
    }
  }
  return counts;
}

/** The session card a press came from: the press names its ActivityKit id. */
export function findSessionCard(activityId: string): SessionActivity | null {
  return readInstances(true).find(activity => activity.getId() === activityId) ?? null;
}

/**
 * Draw an Approve press on its card: the Approving… pill while it runs, the
 * failure line after a retryable failure, or (with `answered`) the card
 * without Approve once the request is answered or gone. The server's next push
 * brings the new status.
 */
export async function renderSessionCardPress(
  activity: SessionActivity,
  press: Pick<SessionLiveActivityProps, 'approving' | 'notice'> | null,
  answered = false
): Promise<void> {
  const current = activity.getProps();
  if (current?.sessionId === undefined || current.statusKind === undefined) {
    return;
  }
  if (press === null) {
    presses.delete(current.sessionId);
  } else {
    presses.set(current.sessionId, press);
  }
  const { approving: _approving, notice: _notice, ...content } = current;
  const next: SessionLiveActivityProps = {
    ...content,
    ...(answered ? { awaitingPermission: false, approvalKey: null } : {}),
    ...press,
  };
  try {
    await activity.update(
      next,
      STALE_AFTER_SECONDS,
      sessionLiveActivityRelevance(next.statusKind ?? 'running')
    );
  } catch {
    // The next push or foreground corrects the card.
  }
}

/** Test-only: drop the map and the press state. */
export function _resetSessionFollowForTests(): void {
  cards.clear();
  presses.clear();
  listeners.clear();
  revision = 0;
}
