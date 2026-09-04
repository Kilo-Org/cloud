import type { ControlStopReceipt, ControlStopRequest } from '../shared/control-plane-session.js';
import { SANDBOX_CONTROL_OPERATION_LIMIT } from '../shared/sandbox-control-protocol.js';
import type { SessionMessageRecord } from './session-message-queue.js';
import {
  admitSessionStop,
  persistedSessionStopSchema,
  persistedSessionStopsSchema,
  sessionStopReceipt,
  type PersistedSessionStop,
} from './session-stop.js';

const STOP_PREFIX = 'session_stop/';

export type SessionStopLifecyclePersistence = {
  list: () => Iterable<[string, unknown]>;
  readLegacy: () => unknown;
  put: (key: string, value: PersistedSessionStop) => void;
  delete: (key: string) => void;
  deleteLegacy: () => void;
  transaction: <T>(callback: () => T) => T;
};

function key(operationId: string): string {
  return `${STOP_PREFIX}${operationId}`;
}

function isExpired(stop: PersistedSessionStop, now: number): boolean {
  return stop.state !== 'accepted' && now >= stop.request.cleanupDeadlineAt;
}

export function createSessionStopLifecycle(persistence: SessionStopLifecyclePersistence) {
  const entries = (): Array<[string, PersistedSessionStop]> => {
    const stored = [...persistence.list()].map(([storedKey, value]) => {
      const parsed = persistedSessionStopSchema.safeParse(value);
      if (!parsed.success) throw new Error('Persisted Stop state is invalid');
      return [storedKey, parsed.data] as [string, PersistedSessionStop];
    });
    if (stored.length > 0) return stored;
    const legacyValue = persistence.readLegacy();
    if (legacyValue === undefined) return [];
    const legacy = persistedSessionStopsSchema.safeParse(legacyValue);
    if (!legacy.success) throw new Error('Persisted Stop state is invalid');
    return Object.entries(legacy.data).map(([id, stop]) => [key(id), stop]);
  };

  const stops = (): PersistedSessionStop[] => entries().map(([, stop]) => stop);

  const compact = (now = Date.now()): PersistedSessionStop[] => {
    const current = entries();
    const retained = current.filter(([, stop]) => !isExpired(stop, now));
    if (retained.length === current.length) return retained.map(([, stop]) => stop);
    persistence.transaction(() => {
      for (const [storedKey] of current) {
        if (!retained.some(([retainedKey]) => retainedKey === storedKey))
          persistence.delete(storedKey);
      }
      for (const [storedKey, stop] of retained) persistence.put(storedKey, stop);
      persistence.deleteLegacy();
    });
    return retained.map(([, stop]) => stop);
  };

  const persist = (stop: PersistedSessionStop) => {
    for (const [storedKey, current] of entries()) persistence.put(storedKey, current);
    persistence.put(key(stop.request.operationId), stop);
    persistence.deleteLegacy();
  };

  return {
    get(operationId: string): PersistedSessionStop | undefined {
      return compact().find(stop => stop.request.operationId === operationId);
    },
    receipt(operationId: string): ControlStopReceipt | null {
      const stop = compact().find(stop => stop.request.operationId === operationId);
      return stop ? sessionStopReceipt(stop) : null;
    },
    pending(): PersistedSessionStop[] {
      return compact().filter(stop => stop.state === 'accepted');
    },
    admit(input: {
      request: ControlStopRequest;
      messages: readonly SessionMessageRecord[];
      currentSandboxId?: string;
      currentWrapperInstanceId?: string;
      now: number;
      commit: (messages: SessionMessageRecord[], stop: PersistedSessionStop) => boolean;
    }): ControlStopReceipt {
      const current = compact(input.now);
      const existing = current.find(stop => stop.request.operationId === input.request.operationId);
      const result = admitSessionStop({
        messages: input.messages,
        existing,
        request: input.request,
        currentSandboxId: input.currentSandboxId,
        currentWrapperInstanceId: input.currentWrapperInstanceId,
        now: input.now,
      });
      if (!result.stop || existing) return result.receipt;
      if (current.length >= SANDBOX_CONTROL_OPERATION_LIMIT)
        return {
          ...result.receipt,
          state: 'rejected',
          message: 'Stop receipt capacity is unavailable',
        };
      if (!input.commit(result.messages, result.stop))
        throw new Error('Stop intent persistence failed');
      return result.receipt;
    },
    replace(previous: PersistedSessionStop, next: PersistedSessionStop): boolean {
      const current = stops().find(
        stop => stop.request.operationId === previous.request.operationId
      );
      if (
        !current ||
        current.request.operationId !== previous.request.operationId ||
        current.request.cleanupDeadlineAt !== previous.request.cleanupDeadlineAt
      )
        return false;
      persistence.transaction(() => persist(next));
      return true;
    },
    persist,
  };
}
