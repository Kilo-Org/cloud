/**
 * Whether a stored session row still waits on the raise a notification
 * presented.
 *
 * A notification names the raise it presented by that raise's identity: the
 * session row's own status time (`cli_sessions_v2.status_updated_at`), which is
 * the app's raise id everywhere else (see `session-attention.ts`). The answer
 * paths compare that identity against the row they read before they send
 * anything, so an action offered for one raise can never answer a raise that
 * replaced it.
 *
 * A payload posted before the identity existed carries none. Nothing can be
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
 * True when the row waits on the raise the notification presented, or when the
 * payload named none. A different status time is a raise that replaced the
 * presented one, and a row that left the waiting statuses means the presented
 * raise ended.
 */
export function rowWaitsOnPresentedRaise(
  row: SessionRaiseRow,
  action: 'approve' | 'reply',
  raiseId: string | undefined
): boolean {
  if (raiseId === undefined) {
    return true;
  }
  return (
    row.status === raiseStatusFor(action) && sameRaise(row.status_updated_at ?? null, raiseId)
  );
}

/**
 * The presented raise's side of a session that holds no pending ask: `raised`
 * only while the row still waits on that same raise, so the outcome-time read
 * cannot report a raise the notification never presented.
 */
export function presentedRaiseState(
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
 * Whether a standing notification must be re-posted because the raise it
 * presents moved: its kind, or the raise identity it carries. Both change what
 * the notification's own actions answer, so the post follows them in place.
 */
export function postedRaiseChanged(
  previous: { kind: string; raiseId: string | null },
  next: { kind: string; raiseId: string | null }
): boolean {
  return previous.kind !== next.kind || previous.raiseId !== next.raiseId;
}

/**
 * Read the presented raise's current server-side state fresh at outcome time:
 * the raise may have moved on (answered elsewhere) between the notification
 * being posted and this tap, which is what separates an ended raise from a gone
 * one. A failed read cannot prove anything either way, so it reports `unknown`
 * — the caller keeps the actions rather than announcing an outcome it cannot
 * back.
 */
export async function readPresentedRaiseState(args: {
  getSession: (kiloSessionId: string) => Promise<SessionRaiseRow>;
  kiloSessionId: string;
  action: 'approve' | 'reply';
  raiseId: string | undefined;
}): Promise<'raised' | 'moved' | 'unknown'> {
  try {
    return presentedRaiseState(await args.getSession(args.kiloSessionId), args.action, args.raiseId);
  } catch {
    return 'unknown';
  }
}