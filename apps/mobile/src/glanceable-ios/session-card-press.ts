import { GLANCEABLE_STALE_MS } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { sessionLiveActivityRelevance } from '@kilocode/notifications/schemas';
import { type LiveActivity } from 'expo-widgets';

import {
  assertSurfaceFailureHandled,
  createSurfaceFeedbackStore,
  type SurfaceAttempt,
  type SurfaceFeedback,
} from '@/lib/surface-feedback';
import { getSessionLiveActivity, type SessionLiveActivityProps } from './session-live-activity';

/**
 * The native reads every session card writer shares, and the Approve press
 * state a card draws (`.specs/mobile-session-live-activity.md`). The follow
 * controller (`session-follow.ts`) and the press handler (`interaction.ts`)
 * both write cards through these, so a press and a tray update draw the same
 * content with the same stale date and relevance.
 */

export type SessionActivity = LiveActivity<SessionLiveActivityProps>;

export type SessionCardPressFailure = {
  readonly kind: 'approve-failed';
  readonly notice: string;
};

/**
 * One approval request on one card. The request is part of the key, so a later
 * request for the same session can never inherit an older one's press state.
 */
export type SessionCardPressKey = string;

/** ActivityKit takes the stale window in seconds. */
export const SESSION_CARD_STALE_AFTER_SECONDS = GLANCEABLE_STALE_MS / 1000;

const presses = createSurfaceFeedbackStore<SessionCardPressKey, SessionCardPressFailure>();

/** Every native session card, or null when ActivityKit cannot be read. */
export function readSessionCards(includeEnded: boolean): SessionActivity[] | null {
  try {
    return getSessionLiveActivity().getInstances(includeEnded);
  } catch {
    return null;
  }
}

/** The card's place among this app's cards: its band, then the newer state change. */
export function sessionCardRelevance(
  props: Pick<SessionLiveActivityProps, 'statusKind' | 'statusSince'>
): number {
  return sessionLiveActivityRelevance(props.statusKind ?? 'running', props.statusSince ?? null);
}

/** Run native card work whose failure has nothing left to correct. */
export async function settleCardWork(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch {
    // The card iOS already removed, or the next push or foreground corrects it.
  }
}

/** The key of one request on one card. */
export function sessionCardPressKey(
  sessionId: string,
  approvalKey: string | null
): SessionCardPressKey {
  return `${sessionId}\u0000${approvalKey ?? ''}`;
}

/** The key of the request a card shows, or null when it awaits no answer. */
export function cardPressKey(
  props: SessionLiveActivityProps | null | undefined
): SessionCardPressKey | null {
  if (props?.awaitingPermission !== true) {
    return null;
  }
  const sessionId = props.sessionId;
  if (sessionId === undefined || sessionId.length === 0) {
    return null;
  }
  return sessionCardPressKey(sessionId, props.approvalKey ?? null);
}

/** Admit one press on the request the card shows; null while one is in flight. */
export function beginSessionCardPress(
  key: SessionCardPressKey
): SurfaceAttempt<SessionCardPressFailure> | null {
  return presses.begin(key);
}

/** The native press fields one phase paints on a card. */
type SessionCardPressProps = { readonly approving?: true; readonly notice?: string };

/** The native props for one phase. `idle` and `succeeded` paint nothing. */
function cardPressProps(
  feedback: SurfaceFeedback<SessionCardPressFailure> | undefined
): SessionCardPressProps {
  // A new phase must be handled here: the switch ends in the never-guard, so an
  // added status is a compile error instead of a silently blank card.
  switch (feedback?.status) {
    case 'pending': {
      return { approving: true };
    }
    case 'failed': {
      return { notice: feedback.failure.notice };
    }
    case undefined:
    case 'idle':
    case 'succeeded': {
      return {};
    }
    default: {
      return assertSurfaceFailureHandled(feedback);
    }
  }
}

/** The press props a tray rebuild keeps for the request the card still shows. */
export function currentCardPressProps(
  props: SessionLiveActivityProps | null | undefined
): SessionCardPressProps {
  const key = cardPressKey(props);
  return key === null ? {} : cardPressProps(presses.getSnapshot().states.get(key));
}

/**
 * Forget the press entries of one session that are not its current request, so
 * a tray rebuild cannot re-draw an older request's line and the store holds at
 * most one entry per live request.
 */
export function forgetSessionCardPress(
  sessionId: string,
  currentKey: SessionCardPressKey | null
): void {
  const prefix = `${sessionId}\u0000`;
  for (const key of presses.getSnapshot().states.keys()) {
    if (key.startsWith(prefix) && key !== currentKey) {
      presses.reset(key);
    }
  }
}

/**
 * Forget the press entries of one session that are not its current request, or
 * of every session when no session is named.
 */
export function clearSessionCardPress(sessionId?: string): void {
  if (sessionId === undefined) {
    presses.invalidateAll();
    return;
  }
  const prefix = `${sessionId}\u0000`;
  for (const key of presses.getSnapshot().states.keys()) {
    if (key.startsWith(prefix)) {
      presses.reset(key);
    }
  }
}

/** The keys the press store holds, so a test can prove its growth is bounded. */
export function _sessionCardPressKeysForTests(): SessionCardPressKey[] {
  return [...presses.getSnapshot().states.keys()];
}

/** The session card a press came from: the press names its ActivityKit id. */
export function findSessionCard(activityId: string): SessionActivity | null {
  return (readSessionCards(true) ?? []).find(activity => activity.getId() === activityId) ?? null;
}

/**
 * Draw one press on its card: the Approving… pill while it runs and the failure
 * line after a retryable failure both come from the press entry, and with
 * `answered` the card also drops Approve. A press for a request the card no
 * longer shows paints nothing and drops only its own entry, so a late
 * settlement can never relabel a newer request.
 */
export async function renderSessionCardPress(
  activity: SessionActivity,
  key: SessionCardPressKey,
  answered = false
): Promise<void> {
  const current = activity.getProps();
  if (current?.sessionId === undefined || current.statusKind === undefined) {
    return;
  }
  if (cardPressKey(current) !== key) {
    presses.reset(key);
    return;
  }
  const { approving: _approving, notice: _notice, ...content } = current;
  const next: SessionLiveActivityProps = {
    ...content,
    ...(answered ? { awaitingPermission: false, approvalKey: null } : {}),
    ...cardPressProps(presses.getSnapshot().states.get(key)),
  };
  await settleCardWork(
    activity.update(next, SESSION_CARD_STALE_AFTER_SECONDS, sessionCardRelevance(next))
  );
}
