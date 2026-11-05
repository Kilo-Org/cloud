import type {
  ControlPlaneHistoryResultFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';

const HISTORY_PAGE_TIMEOUT_MS = 30_000;
const MAX_PENDING_HISTORY_PAGES = 16;

export type HistoryPageRequest = {
  sessionId: string;
  kiloSessionId: string;
  cursor?: string;
  signal?: AbortSignal;
};

/**
 * Wrapper-initiated reads of a session's Cloud history over the control socket.
 * Each page waits for its `history.result` within a bound; a dropped socket
 * fails every waiting page at once.
 */
export function createHistoryRequests(deps: { send(frame: ControlPlaneWrapperFrame): void }) {
  const pending = new Map<
    string,
    { resolve(page: unknown): void; reject(error: Error): void; settle(): void }
  >();

  function readPage(request: HistoryPageRequest): Promise<unknown> {
    if (request.signal?.aborted) return Promise.reject(new Error('History read was aborted'));
    if (pending.size >= MAX_PENDING_HISTORY_PAGES)
      return Promise.reject(new Error('Too many history reads are waiting'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => entry.reject(new Error('History read was aborted'));
      const timer = setTimeout(
        () => entry.reject(new Error('History read timed out')),
        HISTORY_PAGE_TIMEOUT_MS
      );
      const entry = {
        settle() {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
          pending.delete(requestId);
        },
        resolve(page: unknown) {
          entry.settle();
          resolve(page);
        },
        reject(error: Error) {
          entry.settle();
          reject(error);
        },
      };
      pending.set(requestId, entry);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      deps.send({
        type: 'history.page',
        requestId,
        sessionId: request.sessionId,
        kiloSessionId: request.kiloSessionId,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
    });
  }

  return {
    readPage,
    handle(frame: ControlPlaneHistoryResultFrame): void {
      const entry = pending.get(frame.requestId);
      if (entry === undefined) return;
      if (frame.ok) entry.resolve(frame.page);
      else entry.reject(new Error(`History read failed: ${frame.error.code}`));
    },
    disconnected(): void {
      for (const entry of [...pending.values()])
        entry.reject(new Error('Control connection closed during a history read'));
    },
  };
}
