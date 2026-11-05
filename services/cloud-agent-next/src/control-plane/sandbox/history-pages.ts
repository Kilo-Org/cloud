import { withTimeout } from '@kilocode/worker-utils';
import type {
  ControlPlaneHistoryPageFrame,
  ControlPlaneHistoryResultFrame,
} from '../../shared/control-plane-protocol.js';
import type { SessionMessagesPage } from '../session/history.js';
import type { RouteRecord } from './routes.js';

/** Pages are bounded by bytes in the Session DO; this bounds the count per page. */
const HISTORY_PAGE_LIMIT = 100;
const HISTORY_PAGE_TIMEOUT_MS = 10_000;

export type HistoryPageSession = {
  getSessionMessagesPage(input: {
    cursor?: string;
    limit?: number;
    expectedRootKiloSessionId?: string;
  }): Promise<SessionMessagesPage | null>;
};

/**
 * Serves one `history.page` request from the bound wrapper. The wrapper may read
 * only the root history of a route this sandbox hosts; the Session DO checks
 * that a cursor belongs to that session and root.
 */
export async function serveHistoryPage(input: {
  frame: ControlPlaneHistoryPageFrame;
  readRoute(sessionId: string): Promise<RouteRecord | null>;
  session(sessionId: string): Promise<HistoryPageSession | null>;
  send(frame: ControlPlaneHistoryResultFrame): void;
}): Promise<void> {
  const { frame } = input;
  const fail = (code: string, message: string, retryable: boolean) =>
    input.send({
      type: 'history.result',
      requestId: frame.requestId,
      ok: false,
      error: { code, message, retryable },
    });
  try {
    const route = await input.readRoute(frame.sessionId);
    if (route?.spec.kiloSessionId !== frame.kiloSessionId)
      return fail('not_found', 'Session is not hosted by this sandbox', false);
    const session = await input.session(frame.sessionId);
    if (session === null) return fail('not_ready', 'Session history is unavailable', true);
    const page = await withTimeout(
      session.getSessionMessagesPage({
        ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
        limit: HISTORY_PAGE_LIMIT,
        expectedRootKiloSessionId: frame.kiloSessionId,
      }),
      HISTORY_PAGE_TIMEOUT_MS,
      'Session history page timed out'
    );
    if (page === null) return fail('not_found', 'Session history was not found', false);
    input.send({ type: 'history.result', requestId: frame.requestId, ok: true, page });
  } catch {
    fail('unavailable', 'Session history is temporarily unavailable', true);
  }
}
