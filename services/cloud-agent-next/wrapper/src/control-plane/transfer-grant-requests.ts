import type {
  ControlPlaneTransferGrantResultFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';

const TRANSFER_GRANT_TIMEOUT_MS = 10_000;
const MAX_PENDING_TRANSFER_GRANTS = 4;

export type RequestedTransferGrant = {
  grant: string;
  expiresAt: number;
};

export type TransferGrantRequest = {
  signal?: AbortSignal;
};

/**
 * Wrapper-initiated renewal of the sandbox transfer grant over the control
 * socket. Each request waits for its result within a bound; a dropped socket
 * fails every waiting request at once.
 */
export function createTransferGrantRequests(deps: { send(frame: ControlPlaneWrapperFrame): void }) {
  const pending = new Map<
    string,
    {
      resolve(grant: RequestedTransferGrant): void;
      reject(error: Error): void;
      settle(): void;
    }
  >();

  function requestGrant(request: TransferGrantRequest = {}): Promise<RequestedTransferGrant> {
    if (request.signal?.aborted)
      return Promise.reject(new Error('Transfer grant renewal was aborted'));
    if (pending.size >= MAX_PENDING_TRANSFER_GRANTS)
      return Promise.reject(new Error('Too many transfer grant renewals are waiting'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => entry.reject(new Error('Transfer grant renewal was aborted'));
      const timer = setTimeout(
        () => entry.reject(new Error('Transfer grant renewal timed out')),
        TRANSFER_GRANT_TIMEOUT_MS
      );
      const entry = {
        settle() {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
          pending.delete(requestId);
        },
        resolve(grant: RequestedTransferGrant) {
          entry.settle();
          resolve(grant);
        },
        reject(error: Error) {
          entry.settle();
          reject(error);
        },
      };
      pending.set(requestId, entry);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      deps.send({ type: 'transfer.grant', requestId });
    });
  }

  return {
    requestGrant,
    handle(frame: ControlPlaneTransferGrantResultFrame): void {
      const entry = pending.get(frame.requestId);
      if (entry === undefined) return;
      if (frame.ok) entry.resolve({ grant: frame.grant, expiresAt: frame.expiresAt });
      else entry.reject(new Error(`Transfer grant renewal failed: ${frame.error.code}`));
    },
    disconnected(): void {
      for (const entry of [...pending.values()])
        entry.reject(new Error('Control connection closed during transfer grant renewal'));
    },
  };
}
