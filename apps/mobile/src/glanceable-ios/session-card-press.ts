import { GLANCEABLE_STALE_MS } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { sessionLiveActivityRelevance } from '@kilocode/notifications';
import { type LiveActivity } from 'expo-widgets';

import { getSessionLiveActivity, type SessionLiveActivityProps } from './session-live-activity';

/**
 * The native reads every session card writer shares, and the Approve press
 * state a card draws (`.specs/mobile-session-live-activity.md`). The follow
 * controller (`session-follow.ts`) and the press handler (`interaction.ts`)
 * both write cards through these, so a press and a tray update draw the same
 * content with the same stale date and relevance.
 */

export type SessionActivity = LiveActivity<SessionLiveActivityProps>;

type PressState = Pick<SessionLiveActivityProps, 'approving' | 'notice'>;

/** ActivityKit takes the stale window in seconds. */
export const SESSION_CARD_STALE_AFTER_SECONDS = GLANCEABLE_STALE_MS / 1000;

/** The in-flight Approve press or its failure line, by session id. */
const presses = new Map<string, PressState>();

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

/** The press state a tray update keeps on the card. */
export function sessionCardPress(sessionId: string): PressState | undefined {
  return presses.get(sessionId);
}

/** Forget the press state of one session, or of every session. */
export function clearSessionCardPress(sessionId?: string): void {
  if (sessionId === undefined) {
    presses.clear();
  } else {
    presses.delete(sessionId);
  }
}

/** The session card a press came from: the press names its ActivityKit id. */
export function findSessionCard(activityId: string): SessionActivity | null {
  return (readSessionCards(true) ?? []).find(activity => activity.getId() === activityId) ?? null;
}

/**
 * Draw an Approve press on its card: the Approving… pill while it runs, the
 * failure line after a retryable failure, or (with `answered`) the card
 * without Approve once the request is answered or gone. The server's next push
 * brings the new status.
 */
export async function renderSessionCardPress(
  activity: SessionActivity,
  press: PressState | null,
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
  await settleCardWork(
    activity.update(next, SESSION_CARD_STALE_AFTER_SECONDS, sessionCardRelevance(next))
  );
}
