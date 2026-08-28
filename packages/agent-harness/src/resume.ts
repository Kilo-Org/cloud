import { z } from 'zod';
import type { ReadInput } from './commands';
import {
  ErrorSchema,
  EventEnvelopeSchema,
  HistoryCursorSchema,
  MessageSchema,
  SnapshotSchema,
} from './contracts';
import {
  harnessReducer,
  initialHarnessState,
  SynchronizationError,
  type HarnessState,
  type SyncFailure,
} from './state';
import { AGENT_HARNESS_PROTOCOL_VERSION } from './version';

export const EventPageSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('events'), events: z.array(EventEnvelopeSchema).max(200) }),
  z.strictObject({ status: z.literal('cursor_expired') }),
]);
export const HistoryPageSchema = z.strictObject({
  messages: z.array(MessageSchema).max(200),
  historyCursor: HistoryCursorSchema.nullable(),
});
export type HarnessTransport = { read: (input: ReadInput) => Promise<unknown> };
export type HarnessClock = {
  now: () => number;
  schedule: (callback: () => void, delay: number) => () => void;
};
export type ChangeSource = { subscribe: (listener: () => void) => () => void };
export type ResumeOptions = {
  conversationId: string;
  clientId: string;
  transport: HarnessTransport;
  clock: HarnessClock;
  // Journal and bridge changes are sync hints, never authority to execute an effect.
  journal?: ChangeSource;
  bridge?: ChangeSource;
  pollIntervalMs?: number;
};
function decode<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new SynchronizationError(
    parsed.error.issues.some(issue => issue.path.includes('protocolVersion'))
      ? 'unsupported_protocol'
      : 'invalid_output'
  );
}
function failure(error: unknown): SyncFailure {
  if (error instanceof SynchronizationError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  const parsed = ErrorSchema.safeParse(error);
  return parsed.success
    ? parsed.data
    : {
        code: 'connection_lost',
        message: 'Unable to synchronize.',
        retryable: true,
      };
}

export function createHarnessStore(options: ResumeOptions) {
  const { transport, clock } = options;
  const scope = {
    protocolVersion: AGENT_HARNESS_PROTOCOL_VERSION,
    clientId: options.clientId,
    conversationId: options.conversationId,
  } as const;
  const interval = options.pollIntervalMs ?? 1000;
  let state = initialHarnessState();
  let disposed = false,
    needsSnapshot = true,
    generation = 0,
    failures = 0,
    delay = interval;
  let running: Promise<void> | undefined;
  let cancelPoll: (() => void) | undefined;
  const listeners = new Set<() => void>();
  function publish(next: HarnessState) {
    if (disposed || next === state) return;
    state = next;
    listeners.forEach(listener => listener());
  }
  async function synchronize() {
    if (disposed) return;
    if (state.connection.status !== 'connected')
      publish({ ...state, connection: { status: 'connecting' } });
    try {
      // One immediate replacement per pass; repeated gaps back off instead of spinning.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (disposed) return;
        if (needsSnapshot) {
          const raw = await transport.read({ ...scope, type: 'getSnapshot' });
          if (disposed) return;
          const snapshot = decode(SnapshotSchema, raw);
          if (snapshot.conversation.id !== scope.conversationId)
            throw new SynchronizationError('invalid_output');
          publish(harnessReducer(state, { type: 'snapshot', snapshot }));
          generation++;
          needsSnapshot = false;
        }
        if (disposed) return;
        const raw = await transport.read({
          ...scope,
          type: 'getEvents',
          after: state.eventCursor,
          limit: 200,
        });
        if (disposed) return;
        const page = decode(EventPageSchema, raw);
        needsSnapshot = page.status === 'cursor_expired';
        if (page.status === 'events') {
          try {
            publish(
              page.events.reduce(
                (next, envelope) => harnessReducer(next, { type: 'event', envelope }),
                state
              )
            );
          } catch (error) {
            if (!(error instanceof SynchronizationError) || error.code !== 'event_gap') throw error;
            needsSnapshot = true;
          }
        }
        if (needsSnapshot) continue;
        failures = 0;
        delay = interval;
        publish({ ...state, connection: { status: 'connected' } });
        return;
      }
      throw new SynchronizationError('event_gap', true);
    } catch (error) {
      const problem = failure(error);
      delay = Math.min(interval * 2 ** failures++, 30_000);
      publish({
        ...state,
        connection: problem.retryable
          ? { status: 'retrying', error: problem, retryAt: clock.now() + delay }
          : { status: 'blocked', error: problem },
      });
    }
  }
  function refresh(): Promise<void> {
    if (disposed || state.connection.status === 'blocked') return Promise.resolve();
    if (running) return running;
    cancelPoll?.();
    running = Promise.resolve()
      .then(synchronize)
      .finally(() => {
        running = undefined;
        if (!disposed && state.connection.status !== 'blocked')
          cancelPoll = clock.schedule(() => {
            void refresh();
          }, delay);
      });
    return running;
  }
  const closeSources = [options.journal, options.bridge].flatMap(source =>
    source
      ? [
          source.subscribe(() => {
            void refresh();
          }),
        ]
      : []
  );
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    async loadHistory() {
      const before = state.historyCursor,
        started = generation;
      const blocked = () => disposed || state.connection.status === 'blocked';
      if (blocked() || before === null) return;
      const raw = await transport.read({ ...scope, type: 'getHistory', before, limit: 50 });
      if (blocked() || started !== generation || before !== state.historyCursor) return;
      publish(harnessReducer(state, { type: 'history', page: decode(HistoryPageSchema, raw) }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPoll?.();
      closeSources.forEach(close => close());
      state = { ...state, connection: { status: 'disposed' } };
      listeners.forEach(listener => listener());
      listeners.clear();
    },
  };
}
export type HarnessStore = ReturnType<typeof createHarnessStore>;
