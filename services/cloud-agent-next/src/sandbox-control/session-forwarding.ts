import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT,
  SANDBOX_EVENT_BATCH_MAX_ITEMS,
} from '../shared/sandbox-control-protocol.js';

const MAX_SESSION_FORWARD_BYTES = 4 * MAX_SANDBOX_CONTROL_FRAME_BYTES;

export class SessionForwardingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly stage?: 'before_forward' | 'after_forward'
  ) {
    super(message);
    this.name = 'SessionForwardingError';
  }
}

export type SessionForwardingStats = {
  waiting: number;
  inFlight: number;
  bufferedBytes: number;
};

export type SessionForwardRunMember<TItem> = {
  readonly item: TItem;
  readonly bytes: number;
  readonly items: number;
  /** Frames already queued for this session when this frame was admitted; sampled at admission, never at completion. */
  readonly admissionDepth: number;
};

export type SessionForward<TItem, TResult> = {
  sessionId: string;
  /** `null` = never merge (single frames and operation results). */
  identity: string | null;
  bytes: number;
  items: number;
  item: TItem;
  /** Forwards one contiguous run in arrival order; returns one result per member. */
  run: (members: readonly SessionForwardRunMember<TItem>[]) => Promise<readonly TResult[]>;
};

export type SessionForwarding = {
  enqueue: <TItem, TResult>(input: SessionForward<TItem, TResult>) => Promise<TResult>;
  stats: () => SessionForwardingStats;
  get: (sessionId: string) => Promise<void> | undefined;
};

type Entry = {
  readonly identity: string | null;
  readonly bytes: number;
  readonly items: number;
  readonly admissionDepth: number;
  readonly item: unknown;
  readonly run: (
    members: readonly SessionForwardRunMember<unknown>[]
  ) => Promise<readonly unknown[]>;
  readonly settle: (result: unknown) => void;
  readonly fail: (error: unknown) => void;
};

type Session = { queue: Entry[]; pump?: Promise<void> };

export function createSessionForwarding(): SessionForwarding {
  const sessions = new Map<string, Session>();
  const stats: SessionForwardingStats = { waiting: 0, inFlight: 0, bufferedBytes: 0 };

  const capacityAvailable = (bytes: number): boolean =>
    stats.waiting + stats.inFlight < SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT &&
    stats.bufferedBytes + bytes <= MAX_SESSION_FORWARD_BYTES;

  const selectRun = (queue: readonly Entry[]): Entry[] => {
    const head = queue[0];
    if (head.identity === null) return [head];
    const run = [head];
    let items = head.items;
    let bytes = head.bytes;
    for (let index = 1; index < queue.length; index++) {
      const candidate = queue[index];
      if (candidate.identity !== head.identity) break;
      if (items + candidate.items > SANDBOX_EVENT_BATCH_MAX_ITEMS) break;
      if (bytes + candidate.bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES) break;
      run.push(candidate);
      items += candidate.items;
      bytes += candidate.bytes;
    }
    return run;
  };

  const executeRun = async (run: readonly Entry[]): Promise<void> => {
    stats.waiting -= run.length;
    stats.inFlight += run.length;
    try {
      const members: SessionForwardRunMember<unknown>[] = run.map(member => ({
        item: member.item,
        bytes: member.bytes,
        items: member.items,
        admissionDepth: member.admissionDepth,
      }));
      const results = await run[0].run(members);
      if (results.length !== run.length)
        throw new SessionForwardingError(
          'Forwarding results are inconsistent',
          false,
          'after_forward'
        );
      for (let index = 0; index < run.length; index++) run[index].settle(results[index]);
    } catch (error) {
      for (const member of run) member.fail(error);
    } finally {
      for (const member of run) {
        stats.inFlight--;
        stats.bufferedBytes -= member.bytes;
      }
    }
  };

  const pump = async (session: Session, sessionId: string): Promise<void> => {
    while (session.queue.length > 0) {
      const run = selectRun(session.queue);
      session.queue.splice(0, run.length);
      // Publish `session.pump` before any caller `run` executes.
      await Promise.resolve();
      await executeRun(run);
    }
    session.pump = undefined;
    sessions.delete(sessionId);
  };

  const enqueue = <TItem, TResult>(input: SessionForward<TItem, TResult>): Promise<TResult> => {
    if (input.bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES)
      return Promise.reject(
        new SessionForwardingError('Forwarded frame is too large', false, 'before_forward')
      );
    if (input.items > SANDBOX_EVENT_BATCH_MAX_ITEMS)
      return Promise.reject(
        new SessionForwardingError('Forwarded batch is too large', false, 'before_forward')
      );
    if (!capacityAvailable(input.bytes))
      return Promise.reject(new SessionForwardingError('Forwarding capacity is unavailable', true));
    let session = sessions.get(input.sessionId);
    if (session === undefined) {
      session = { queue: [] };
      sessions.set(input.sessionId, session);
    }
    const deferred = Promise.withResolvers<TResult>();
    session.queue.push({
      identity: input.identity,
      bytes: input.bytes,
      items: input.items,
      admissionDepth: session.queue.length,
      item: input.item,
      run: input.run as (
        members: readonly SessionForwardRunMember<unknown>[]
      ) => Promise<readonly unknown[]>,
      settle: result => deferred.resolve(result as TResult),
      fail: error => deferred.reject(error),
    });
    stats.waiting++;
    stats.bufferedBytes += input.bytes;
    if (session.pump === undefined) session.pump = pump(session, input.sessionId);
    return deferred.promise;
  };

  return {
    enqueue,
    stats: () => ({ ...stats }),
    get: sessionId => sessions.get(sessionId)?.pump,
  };
}
