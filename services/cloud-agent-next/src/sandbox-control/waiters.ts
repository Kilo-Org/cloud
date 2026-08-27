import {
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  type ResponseFrame,
} from '../shared/sandbox-control-protocol.js';

export class SandboxControlConnectionError extends Error {
  readonly code = 'not_ready';
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'SandboxControlConnectionError';
  }
}

type PendingWaiter = {
  resolve: (frame: ResponseFrame) => void;
  reject: (error: SandboxControlConnectionError) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type ControlRequestWaiters = {
  wait(requestId: string, timeoutMs?: number): Promise<ResponseFrame>;
  settle(frame: ResponseFrame): boolean;
  rejectAll(message: string): void;
  pendingCount(): number;
};

export function createControlRequestWaiters(
  defaultTimeoutMs = SANDBOX_CONTROL_REQUEST_TIMEOUT_MS
): ControlRequestWaiters {
  const pending = new Map<string, PendingWaiter>();

  function take(requestId: string): PendingWaiter | undefined {
    const waiter = pending.get(requestId);
    if (!waiter) return undefined;
    pending.delete(requestId);
    clearTimeout(waiter.timeout);
    return waiter;
  }

  return {
    wait(requestId: string, timeoutMs = defaultTimeoutMs): Promise<ResponseFrame> {
      if (pending.has(requestId)) {
        return Promise.reject(new SandboxControlConnectionError('Duplicate requestId'));
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new SandboxControlConnectionError('sandbox control request timeout'));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timeout });
      });
    },

    settle(frame: ResponseFrame): boolean {
      const waiter = take(frame.requestId);
      if (!waiter) return false;
      waiter.resolve(frame);
      return true;
    },

    rejectAll(message: string): void {
      const error = new SandboxControlConnectionError(message);
      for (const [requestId, waiter] of pending) {
        clearTimeout(waiter.timeout);
        pending.delete(requestId);
        waiter.reject(error);
      }
    },

    pendingCount(): number {
      return pending.size;
    },
  };
}
