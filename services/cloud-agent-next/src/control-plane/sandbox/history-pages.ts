import { withTimeout } from '@kilocode/worker-utils';
import type {
  ControlPlaneHistoryPageFrame,
  ControlPlaneHistoryRecentFrame,
  ControlPlaneHistoryResultFrame,
  WorkspaceHistorySession,
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
 * the root history of a hosted route, or an authorized sibling in its workspace.
 * The Session DO checks that a cursor belongs to that session and root.
 */
export async function serveHistoryPage(input: {
  frame: ControlPlaneHistoryPageFrame;
  readRoute(sessionId: string): Promise<RouteRecord | null>;
  authorizeWorkspaceSession?(
    route: RouteRecord,
    target: { sessionId: string; kiloSessionId: string }
  ): Promise<boolean>;
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
    const route = await input.readRoute(frame.workspaceSessionId ?? frame.sessionId);
    const authorized = frame.workspaceSessionId
      ? route !== null && (await input.authorizeWorkspaceSession?.(route, frame)) === true
      : route?.spec.kiloSessionId === frame.kiloSessionId;
    if (!authorized) return fail('not_found', 'Session is not hosted by this sandbox', false);
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

/** Discovery is a bounded read, never a route attachment or a session execution. */
export async function serveRecentHistory(input: {
  frame: ControlPlaneHistoryRecentFrame;
  readRoute(sessionId: string): Promise<RouteRecord | null>;
  readRecent(route: RouteRecord): Promise<WorkspaceHistorySession[]>;
  send(frame: ControlPlaneHistoryResultFrame): void;
}): Promise<void> {
  const { requestId, sessionId } = input.frame;
  try {
    const route = await input.readRoute(sessionId);
    const page =
      route === null
        ? []
        : await withTimeout(
            input.readRecent(route),
            HISTORY_PAGE_TIMEOUT_MS,
            'Workspace history discovery timed out'
          );
    input.send({ type: 'history.result', requestId, ok: true, page });
  } catch {
    input.send({
      type: 'history.result',
      requestId,
      ok: false,
      error: { code: 'unavailable', message: 'Workspace history is unavailable', retryable: true },
    });
  }
}
