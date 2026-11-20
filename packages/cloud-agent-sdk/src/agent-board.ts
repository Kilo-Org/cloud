import { agentBoardSchema, type AgentBoard } from '@kilocode/session-ingest-contracts';

export type AgentBoardState = { status: 'inactive' } | { status: 'current'; board: AgentBoard };

// Failed reads back off from 500 ms, so retries span about 15 s while a runtime attaches.
const MAX_RETRIES = 5;

/**
 * Keeps the newest board page of one root session current. The board lives in
 * the runtime, so an offline runtime or a failed read keeps the last page read.
 */
export function createAgentBoardReader(options: {
  ownerSessionID: string;
  read: (signal: AbortSignal) => Promise<unknown>;
  publish: (state: AgentBoardState) => void;
}) {
  let active = false;
  let dirty = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingRead: AbortController | undefined;
  function schedule(delay: number) {
    if (!active || pendingRead || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, delay);
  }
  async function refresh() {
    if (!active || pendingRead) return;
    dirty = false;
    const request = new AbortController();
    pendingRead = request;
    let failed = false;
    try {
      const value = await options.read(request.signal);
      if (pendingRead === request && value !== null) {
        const board = agentBoardSchema.parse(value);
        if (board.ownerSessionID !== options.ownerSessionID)
          throw new Error('Agent board owner mismatch');
        retries = 0;
        options.publish({ status: 'current', board });
      }
    } catch {
      failed = pendingRead === request;
    } finally {
      if (pendingRead === request) {
        pendingRead = undefined;
        if (failed && !dirty && retries < MAX_RETRIES) {
          retries++;
          schedule(500 * 2 ** (retries - 1));
        } else if (dirty) schedule(500);
      }
    }
  }
  function invalidate(delay = 500) {
    if (!active) return;
    retries = 0;
    dirty = true;
    schedule(delay);
  }
  return {
    start() {
      active = true;
      invalidate(100);
    },
    invalidate: () => invalidate(),
    stop() {
      pendingRead?.abort();
      pendingRead = undefined;
      active = false;
      dirty = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
