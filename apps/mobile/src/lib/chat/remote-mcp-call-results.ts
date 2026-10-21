import { type RemoteMcpCallAnswered } from '@kilocode/harness-sdk/plugins/remote-mcp';

/**
 * The whole answer a call received, kept for the row that draws it.
 *
 * A transcript holds the text the model read; a view renders the server's own
 * content and structured result, which the harness hands over here because the
 * text does not carry them. What is kept is bounded twice — by how many answers
 * and by how many characters they hold — because this is the one place in the
 * app that holds a server's own payload after the call is over. A reopened
 * transcript draws its views from the text alone, so nothing waits on an answer
 * that has been evicted.
 */

const MAX_ANSWERS = 50;
const MAX_CHARS = 1_000_000;

const kept = new Map<
  string,
  { readonly answered: RemoteMcpCallAnswered; readonly chars: number }
>();
let keptChars = 0;

/** The length a result counts as, or one when it cannot be measured. */
function charsOf(answered: RemoteMcpCallAnswered): number {
  try {
    return JSON.stringify(answered).length;
  } catch {
    return 1;
  }
}

function forget(callId: string): void {
  const held = kept.get(callId);
  if (held !== undefined) {
    keptChars -= held.chars;
    kept.delete(callId);
  }
}

/** Keeps one answer, evicting the oldest until the collected answers fit. */
export function rememberCallResult(answered: RemoteMcpCallAnswered): void {
  forget(answered.callId);
  const chars = charsOf(answered);
  kept.set(answered.callId, { answered, chars });
  keptChars += chars;
  for (const callId of kept.keys()) {
    const fits = kept.size <= MAX_ANSWERS && keptChars <= MAX_CHARS;
    if (fits) {
      return;
    }
    if (callId !== answered.callId) {
      forget(callId);
    }
  }
}

/** What a call answered, for the view that renders it; the text alone when it is gone. */
export function mcpCallResultOf(callId: string): RemoteMcpCallAnswered | undefined {
  return kept.get(callId)?.answered;
}

/** Drops every answer, as a sign-out or a changed server list does. */
export function forgetCallResults(): void {
  kept.clear();
  keptChars = 0;
}
