import {
  buildSessionLiveActivityContentState,
  type SessionLiveActivityContentState,
  type SessionLiveActivityRow,
} from '@kilocode/notifications';
import { after } from 'expo-widgets';

import {
  getLiveActivityEnabled,
  getNotificationPermissionGranted,
} from '@/lib/glanceable/live-activity-switch';
import {
  type FollowedSessionCounts,
  setFollowedSessionsSource,
} from '@/lib/glanceable/followed-sessions';
import {
  deleteSessionActivityToken,
  observedSessionActivityIds,
  registerSessionActivityToken,
  releaseSessionActivity,
  retrySessionActivityTokens,
} from '@/lib/glanceable/session-activity-tokens';
import { getGlanceableDelivery } from '@/lib/glanceable/sink-registry';
import { launcherSessionUrl } from '@/lib/launcher-surfaces';

import {
  clearSessionCardPress,
  readSessionCards,
  type SessionActivity,
  sessionCardPress,
  sessionCardRelevance,
  settleCardWork,
} from './session-card-press';
import { SessionLiveActivity, type SessionLiveActivityProps } from './session-live-activity';
import { drawsSame, isOlderThanCard, sessionCardStaleAfterSeconds } from './session-card-facts';
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

export type SessionFollowContext = { userId: string; organizationId: string | null };

export type FollowResult = 'started' | 'followed' | 'refused';

/** A finished card stays on the Lock Screen this long (spec "Ending" rule 1). */
export const SESSION_FINISHED_DISMISS_MS = 15 * 60 * 1000;

/** The visible card of each followed session. */
const cards = new Map<string, SessionActivity>();
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

/** The card's push token, or the one it last reported when ActivityKit has none. */
async function readToken(
  activity: SessionActivity,
  reported: string | null
): Promise<string | null> {
  try {
    return (await activity.getPushToken()) ?? reported;
  } catch {
    return reported;
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
  const token = readToken(activity, releaseSessionActivity(activity.getId()));
  getGlanceableDelivery().cleanupTokens('session', token);
  const relevance = props === undefined ? undefined : sessionCardRelevance(props);
  void settleCardWork(activity.end(dismissal, props, new Date(), relevance));
}

/**
 * Rebuild the map from native truth. A second live card for one session is a
 * duplicate (spec "Starting" rule 3), so it ends at once. A card this process
 * knew that is no longer live (iOS or the server ended it) is released, and the
 * token it reported is deleted, so no retry registers a dead token again. An
 * unreadable ActivityKit changes nothing.
 */
export function discoverSessionCards(): SessionActivity[] {
  const instances = readSessionCards(false);
  if (instances === null) {
    return [...cards.values()];
  }
  const liveIds = new Set(instances.map(activity => activity.getId()));
  const known = new Set([
    ...[...cards.values()].map(activity => activity.getId()),
    ...observedSessionActivityIds(),
  ]);
  for (const activityId of known) {
    const reported = liveIds.has(activityId) ? null : releaseSessionActivity(activityId);
    if (reported !== null) {
      deleteSessionActivityToken(reported);
    }
  }
  const next = new Map<string, SessionActivity>();
  for (const activity of instances) {
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
  for (const sessionId of cards.keys()) {
    if (!next.has(sessionId)) {
      clearSessionCardPress(sessionId);
    }
  }
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
    // Retire the token scope first, so it reads each card's token before the
    // end drops it.
    getGlanceableDelivery().cleanupTokens('scope');
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

/** Start the card collapsed and silent, or null when iOS refuses it. */
function startCard(content: SessionLiveActivityContentState): SessionActivity | null {
  try {
    return SessionLiveActivity.start(
      content,
      launcherSessionUrl(content.sessionId),
      sessionCardStaleAfterSeconds(content),
      sessionCardRelevance(content)
    );
  } catch {
    // Live Activities off in Settings, or the system limit of activities.
    return null;
  }
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
  const activity = startCard(content);
  if (activity === null) {
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
  clearSessionCardPress(sessionId);
  endCard(activity, 'immediate');
  emit();
}

/**
 * Opening a session dismisses its finished card at once (spec "Ending" rule 1).
 * A live card stays: the user still follows that session.
 */
export function dismissFinishedSessionCard(sessionId: string): void {
  for (const activity of readSessionCards(true) ?? []) {
    const props = activity.getProps();
    if (props?.sessionId === sessionId && (!isLive(activity) || props.statusKind === 'idle')) {
      if (cards.get(sessionId)?.getId() === activity.getId()) {
        cards.delete(sessionId);
        emit();
      }
      clearSessionCardPress(sessionId);
      endCard(activity, 'immediate');
    }
  }
}

/**
 * End every session card at once: sign-out, an account change, an organization
 * switch, a lost organization, and the in-app switch turned off (spec "Ending"
 * rule 3). Every caller retires the whole token scope first, which reads each
 * card's token and deletes it before the device session is revoked, so this
 * only ends the native cards.
 */
export function endAllSessionCards(): void {
  for (const activity of readSessionCards(true) ?? []) {
    releaseSessionActivity(activity.getId());
    void settleCardWork(activity.end('immediate'));
  }
  clearSessionCardPress();
  if (cards.size > 0) {
    cards.clear();
    emit();
  }
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
    if (row !== undefined && isLive(activity) && !isOlderThanCard(row, current)) {
      const content = buildSessionLiveActivityContentState(row, {
        // A pushed key names the request the server saw; Approve revalidates it.
        approvalKey: current?.approvalKey ?? null,
        updatedAt,
        statusSinceFallback: current?.statusSince ?? updatedAt,
        // A tray row carries no step, plan, diff or outcome: the rebuild keeps
        // the ones the last push delivered instead of wiping them.
        previous: current ?? undefined,
      });
      // A failed run ends like a finished one, with its stop reason.
      if (content.statusKind === 'idle' || content.statusKind === 'failed') {
        cards.delete(sessionId);
        clearSessionCardPress(sessionId);
        ended = true;
        endCard(activity, after(new Date(Date.now() + SESSION_FINISHED_DISMISS_MS)), content);
      } else if (!drawsSame(current, content)) {
        void settleCardWork(
          activity.update(
            { ...content, ...sessionCardPress(sessionId) },
            sessionCardStaleAfterSeconds(content),
            sessionCardRelevance(content)
          )
        );
      }
    }
  }
  if (ended) {
    emit();
  }
}

/** Live counts by status kind of the followed sessions, for the aggregate card. */
export function followedSessionCounts(): FollowedSessionCounts {
  const counts = { running: 0, needsInput: 0, needsApproval: 0, idle: 0, scheduled: 0 };
  for (const activity of cards.values()) {
    const props = isLive(activity) ? activity.getProps() : null;
    if (props?.statusKind !== undefined) {
      // A failed turn is finished work, so it counts with the idle sessions.
      counts[props.statusKind === 'failed' ? 'idle' : props.statusKind] += 1;
      if (props.awaitingPermission === true) {
        counts.needsApproval += 1;
      }
    }
  }
  return counts;
}

// The aggregate card and its Approve read the followed sessions through this
// source, so their test graphs never load ActivityKit or the token graph.
setFollowedSessionsSource({ ids: () => cards.keys(), counts: followedSessionCounts });

/** Test-only: drop the map and the press state. */
export function _resetSessionFollowForTests(): void {
  cards.clear();
  clearSessionCardPress();
  listeners.clear();
  revision = 0;
}
