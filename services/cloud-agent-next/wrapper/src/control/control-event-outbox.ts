import { createHash } from 'node:crypto';
import { canonicalControlEventJson } from '../../../src/shared/control-event-canonical.js';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  sessionEventIdentitySchema,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { SessionEventIdentity } from '../../../src/shared/sandbox-control-protocol.js';

const MAX_EVENTS = 256;
const MAX_BYTES = 4 * MAX_SANDBOX_CONTROL_FRAME_BYTES;
const RETRY_DELAY_MS = 250;

export type ControlEventPublication = {
  event: 'session.event' | 'session.preparing';
  receiptId: string;
  receiptHash: string;
  sequence: number;
  session: SessionEventIdentity;
  payload: unknown;
};

export type PreparedControlEventPublication = ControlEventPublication & {
  bytes: number;
  readonly deadlineAt: number;
};

export type ControlEventOutboxFailure = {
  reason: 'expired' | 'rejected';
  publication: ControlEventPublication;
};

export type ControlEventOutbox = {
  prepare(
    input: Omit<ControlEventPublication, 'receiptId' | 'receiptHash' | 'sequence'>
  ): PreparedControlEventPublication;
  enqueue(publication: PreparedControlEventPublication): boolean;
  waitForSpace(publication: PreparedControlEventPublication): Promise<boolean>;
  pause(): void;
  resume(): Promise<boolean>;
  close(): void;
};

export function createControlEventOutbox(options: {
  publish: (publication: ControlEventPublication, deadlineAt: number) => Promise<void>;
  onFailure: (failure: ControlEventOutboxFailure) => void;
}): ControlEventOutbox {
  const entries: PreparedControlEventPublication[] = [];
  const spaceWaiters = new Map<
    PreparedControlEventPublication,
    {
      promise: Promise<boolean>;
      ready: boolean;
      resolve: (available: boolean) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  let waitingBytes = 0;
  let bytes = 0;
  let paused = true;
  let closed = false;
  let pending: Promise<boolean> | undefined;
  let nextSequence = 0;
  let retryAt: number | undefined;
  let wakeup: ReturnType<typeof setTimeout> | undefined;
  let expirePending: (() => void) | undefined;

  const clearWakeup = () => {
    clearTimeout(wakeup);
    wakeup = undefined;
  };

  const hasSpaceFor = (publication: PreparedControlEventPublication): boolean => {
    if (entries.length >= MAX_EVENTS || bytes + publication.bytes > MAX_BYTES) return false;
    const root = publication.session.rootKiloSessionId ?? publication.session.kiloSessionId;
    for (const reserved of spaceWaiters.keys()) {
      if (
        reserved.sequence < publication.sequence &&
        Date.now() < reserved.deadlineAt &&
        reserved.session.directory === publication.session.directory &&
        (reserved.session.rootKiloSessionId ?? reserved.session.kiloSessionId) === root
      )
        return false;
    }
    return true;
  };

  const releaseSpaceWaiter = (publication: PreparedControlEventPublication) => {
    const waiter = spaceWaiters.get(publication);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    spaceWaiters.delete(publication);
    waitingBytes -= publication.bytes;
    return waiter;
  };

  const notifySpace = (available: boolean) => {
    const now = Date.now();
    for (const [publication, waiter] of spaceWaiters) {
      if (!available || now >= publication.deadlineAt) releaseSpaceWaiter(publication);
      else if (!hasSpaceFor(publication)) continue;
      waiter.ready = true;
      waiter.resolve(available);
    }
  };

  const prepare = (
    input: Omit<ControlEventPublication, 'receiptId' | 'receiptHash' | 'sequence'>
  ): PreparedControlEventPublication => {
    const snapshot = JSON.parse(
      canonicalControlEventJson({
        ...input,
        session: sessionEventIdentitySchema.parse(input.session),
      })
    ) as Omit<ControlEventPublication, 'receiptId' | 'receiptHash' | 'sequence'>;
    const sequence = nextSequence + 1;
    const receiptId = crypto.randomUUID();
    const receiptHash = createHash('sha256')
      .update(canonicalControlEventJson({ ...snapshot, sequence }))
      .digest('hex');
    nextSequence = sequence;
    const publication = { ...snapshot, sequence, receiptId, receiptHash };
    const bytes = Buffer.byteLength(
      JSON.stringify({
        type: 'request',
        requestId: '00000000-0000-4000-8000-000000000000',
        operation: 'sandbox.event.publish',
        payload: publication,
      })
    );
    if (bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES)
      throw new Error('Control event exceeds the frame budget');
    return { ...publication, bytes, deadlineAt: Date.now() + 30_000 };
  };

  const removeHead = (entry: PreparedControlEventPublication) => {
    entries.shift();
    bytes -= entry.bytes;
    retryAt = undefined;
    notifySpace(true);
  };

  const expireHead = () => {
    while (entries[0] && Date.now() >= entries[0].deadlineAt) {
      const entry = entries[0];
      removeHead(entry);
      options.onFailure({ reason: 'expired', publication: entry });
    }
  };

  const scheduleWakeup = () => {
    clearWakeup();
    const entry = entries[0];
    if (closed || pending || !entry) return;
    const nextAt = paused ? entry.deadlineAt : Math.min(retryAt ?? Date.now(), entry.deadlineAt);
    wakeup = setTimeout(
      () => {
        wakeup = undefined;
        expireHead();
        if (!paused) void pump();
        else scheduleWakeup();
      },
      Math.max(1, nextAt - Date.now())
    );
    wakeup.unref();
  };

  const pump = (): Promise<boolean> => {
    if (pending) return pending;
    if (closed) return Promise.resolve(false);
    expireHead();
    if (paused || (retryAt !== undefined && Date.now() < retryAt)) {
      scheduleWakeup();
      return Promise.resolve(entries.length === 0);
    }
    clearWakeup();
    pending = Promise.resolve()
      .then(async () => {
        while (!paused && !closed) {
          expireHead();
          const entry = entries[0];
          if (!entry) return true;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const expired = new Promise<void>(resolve => {
              expirePending = resolve;
              timeout = setTimeout(resolve, Math.max(1, entry.deadlineAt - Date.now()));
              timeout.unref();
            });
            await Promise.race([
              options.publish(
                {
                  event: entry.event,
                  receiptId: entry.receiptId,
                  receiptHash: entry.receiptHash,
                  sequence: entry.sequence,
                  session: entry.session,
                  payload: entry.payload,
                },
                entry.deadlineAt
              ),
              expired,
            ]);
          } catch (error) {
            if (closed) return false;
            if (Date.now() >= entry.deadlineAt) continue;
            if (!(error instanceof Error) || !('retryable' in error) || error.retryable !== true) {
              removeHead(entry);
              options.onFailure({ reason: 'rejected', publication: entry });
              continue;
            }
            retryAt = Date.now() + RETRY_DELAY_MS;
            return false;
          } finally {
            clearTimeout(timeout);
            expirePending = undefined;
          }
          if (closed) return false;
          if (Date.now() >= entry.deadlineAt) continue;
          removeHead(entry);
        }
        return entries.length === 0;
      })
      .finally(() => {
        pending = undefined;
        scheduleWakeup();
      });
    return pending;
  };

  return {
    prepare,
    enqueue(publication) {
      if (closed) return false;
      if (Date.now() >= publication.deadlineAt) {
        releaseSpaceWaiter(publication)?.resolve(true);
        notifySpace(true);
        options.onFailure({ reason: 'expired', publication });
        return true;
      }
      if (!hasSpaceFor(publication)) return false;
      entries.push({ ...publication });
      bytes += publication.bytes;
      releaseSpaceWaiter(publication)?.resolve(true);
      notifySpace(true);
      if (!paused) void pump();
      else scheduleWakeup();
      return true;
    },
    waitForSpace(publication) {
      if (closed) return Promise.resolve(false);
      if (Date.now() >= publication.deadlineAt) return Promise.resolve(true);
      const existing = spaceWaiters.get(publication);
      if (existing) {
        if (existing.ready && !hasSpaceFor(publication)) {
          const { promise, resolve } = Promise.withResolvers<boolean>();
          existing.promise = promise;
          existing.resolve = resolve;
          existing.ready = false;
        }
        return existing.promise;
      }
      if (spaceWaiters.size >= MAX_EVENTS || waitingBytes + publication.bytes > MAX_BYTES)
        return Promise.resolve(false);
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const timeout = setTimeout(
        () => {
          releaseSpaceWaiter(publication)?.resolve(true);
          notifySpace(true);
        },
        Math.max(1, publication.deadlineAt - Date.now())
      );
      timeout.unref();
      const ready = hasSpaceFor(publication);
      spaceWaiters.set(publication, { promise, resolve, timeout, ready });
      waitingBytes += publication.bytes;
      if (ready) resolve(true);
      return promise;
    },
    pause() {
      paused = true;
      scheduleWakeup();
    },
    resume() {
      paused = false;
      return pump();
    },
    close() {
      closed = true;
      clearWakeup();
      expirePending?.();
      entries.length = 0;
      bytes = 0;
      notifySpace(false);
    },
  };
}
