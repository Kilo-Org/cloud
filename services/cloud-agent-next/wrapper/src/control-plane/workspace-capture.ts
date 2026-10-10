import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';

/**
 * The wrapper's side of a repository capture: ask the Sandbox DO to snapshot the
 * container, then wait for its answer. The wait is a backstop over the DO's own
 * capture timeout, so a lost frame or a reconnect never holds preparation open.
 */
export type WorkspaceCapture = {
  /** Resolves `true` only when the DO saved the snapshot; never rejects. */
  request(sessionId: string, commit: string | undefined, timeoutMs: number): Promise<boolean>;
  /** Feeds a `workspace.captured` frame to the request waiting for it. */
  onCaptured(sessionId: string, ok: boolean): void;
};

type Pending = { settle: (ok: boolean) => void };

export function createWorkspaceCapture(options: {
  send: (frame: ControlPlaneWrapperFrame) => void;
}): WorkspaceCapture {
  const pending = new Map<string, Pending>();

  return {
    request(sessionId, commit, timeoutMs) {
      // A new request for the session supersedes one still waiting.
      pending.get(sessionId)?.settle(false);
      return new Promise<boolean>(resolve => {
        const entry: Pending = {
          settle: ok => {
            clearTimeout(timer);
            if (pending.get(sessionId) === entry) pending.delete(sessionId);
            resolve(ok);
          },
        };
        const timer = setTimeout(() => entry.settle(false), timeoutMs);
        pending.set(sessionId, entry);
        options.send({
          type: 'workspace.capture',
          sessionId,
          ...(commit === undefined || commit.length === 0 ? {} : { commit }),
        });
      });
    },
    onCaptured(sessionId, ok) {
      pending.get(sessionId)?.settle(ok);
    },
  };
}
