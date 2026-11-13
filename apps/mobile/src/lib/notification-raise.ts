/**
 * The raise a needs-input notification presents, and whether the session still
 * waits on it.
 *
 * A notification names its raise by that raise's identity: the session row's
 * own status time (`cli_sessions_v2.status_updated_at`), which is the app's
 * raise id everywhere else (see `session-attention.ts`). An answer is sent only
 * while the session waits on that raise.
 *
 * A payload posted before the identity existed carries none. Nothing is
 * compared then, and the caller keeps its earlier behaviour.
 */
import { sameRaise } from '@/lib/session-attention';

/** The stored status fields the comparison reads. */
export type SessionRaiseRow = {
  status?: string | null;
  status_updated_at?: string | null;
};

/** The status a raise of each action is presented as. */
function raiseStatusFor(action: 'approve' | 'reply'): string {
  return action === 'approve' ? 'permission' : 'question';
}

/**
 * True when the row waits on the raise the notification presents, or when the
 * payload named none. A different status time names a different raise, and a
 * row outside the waiting statuses holds none.
 */
export function rowWaitsOnPresentedRaise(
  row: SessionRaiseRow,
  action: 'approve' | 'reply',
  raiseId: string | undefined
): boolean {
  if (raiseId === undefined) {
    return true;
  }
  return row.status === raiseStatusFor(action) && sameRaise(row.status_updated_at ?? null, raiseId);
}

/**
 * The presented raise's side of a session that holds no pending ask: `raised`
 * only while the row waits on the raise the notification presents.
 */
function presentedRaiseState(
  row: SessionRaiseRow,
  action: 'approve' | 'reply',
  raiseId: string | undefined
): 'raised' | 'moved' {
  const waiting = row.status === 'question' || row.status === 'permission';
  if (!waiting || !rowWaitsOnPresentedRaise(row, action, raiseId)) {
    return 'moved';
  }
  return 'raised';
}

/**
 * Whether a standing notification must be posted again because the raise it
 * presents changed: its kind, or the raise identity it carries. Both belong to
 * what the notification's own actions answer, so the post follows them.
 */
export function postedRaiseChanged(
  previous: { kind: string; raiseId: string | null },
  next: { kind: string; raiseId: string | null }
): boolean {
  return previous.kind !== next.kind || previous.raiseId !== next.raiseId;
}

/**
 * Read the presented raise's current server-side state at outcome time: the
 * session may wait on another raise by the time the tap runs, which is what
 * separates an ended raise from a gone one. A failed read proves neither way,
 * so it reports `unknown` and the caller keeps the actions.
 */
export async function readPresentedRaiseState(args: {
  getSession: (kiloSessionId: string) => Promise<SessionRaiseRow>;
  kiloSessionId: string;
  action: 'approve' | 'reply';
  raiseId: string | undefined;
}): Promise<'raised' | 'moved' | 'unknown'> {
  try {
    return presentedRaiseState(
      await args.getSession(args.kiloSessionId),
      args.action,
      args.raiseId
    );
  } catch {
    return 'unknown';
  }
}
/**
 * The answer-time check: the request the live session holds is answered only
 * while the stored row waits on the raise the notification presents. The wait
 * can span a raise, so this read happens immediately before anything is sent.
 *
 * `answer` is the only outcome that sends. `retryable` keeps the actions when
 * the read proves neither way; `unavailable` names the presented raise in the
 * ack, which leaves any other raise with its own badge.
 */
export async function presentedRaiseGate(args: {
  getSession: (kiloSessionId: string) => Promise<SessionRaiseRow>;
  kiloSessionId: string;
  action: 'approve' | 'reply';
  raiseId: string | undefined;
  ack: (kiloSessionId: string, status: string, statusUpdatedAt?: string | null) => void;
}): Promise<'answer' | 'retryable' | 'unavailable'> {
  if (args.raiseId === undefined) {
    return 'answer';
  }
  try {
    const row = await args.getSession(args.kiloSessionId);
    if (presentedRaiseState(row, args.action, args.raiseId) === 'raised') {
      return 'answer';
    }
  } catch {
    return 'retryable';
  }
  args.ack(args.kiloSessionId, raiseStatusFor(args.action), args.raiseId);
  return 'unavailable';
}
