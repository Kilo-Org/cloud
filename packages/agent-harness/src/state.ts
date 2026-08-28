import type { Conversation, EventEnvelope, Interaction, Message, Run, Snapshot } from './contracts';

type ById<T> = Readonly<Record<string, T>>;
export type SyncFailure = { code: string; message: string; retryable: boolean };
export type ConnectionState =
  | { status: 'idle' | 'connecting' | 'connected' | 'disposed' }
  | { status: 'retrying'; error: SyncFailure; retryAt: number }
  | { status: 'blocked'; error: SyncFailure };
export type HistoryPage = { messages: Message[]; historyCursor: string | null };
export type HarnessState = {
  conversation: Conversation | null;
  messages: ById<Message>;
  runs: ById<Run>;
  activeRunId: string | null;
  queuedRunIds: readonly string[];
  interactions: ById<Interaction>;
  pendingClientActions: ById<Snapshot['pendingClientActions'][number]>;
  eventCursor: number;
  historyCursor: string | null;
  connection: ConnectionState;
};
export class SynchronizationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false
  ) {
    super(code);
  }
}
export function initialHarnessState(): HarnessState {
  return {
    conversation: null,
    messages: {},
    runs: {},
    activeRunId: null,
    queuedRunIds: [],
    interactions: {},
    pendingClientActions: {},
    eventCursor: 0,
    historyCursor: null,
    connection: { status: 'idle' },
  };
}
const index = <T extends { id: string }>(records: readonly T[]): ById<T> =>
  Object.fromEntries(records.map(record => [record.id, record]));
export function selectMessages(state: HarnessState): Message[] {
  return Object.values(state.messages).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
}
export type HarnessAction =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'event'; envelope: EventEnvelope }
  | { type: 'history'; page: HistoryPage }
  | { type: 'connection'; connection: ConnectionState };

// Inputs come from the validated resume boundary; history never owns pending work.
export function harnessReducer(state: HarnessState, action: HarnessAction): HarnessState {
  if (action.type === 'connection') return { ...state, connection: action.connection };
  if (action.type === 'history')
    return {
      ...state,
      messages: { ...index(action.page.messages), ...state.messages },
      historyCursor: action.page.historyCursor,
    };
  if (action.type === 'snapshot') {
    const snapshot = action.snapshot;
    if (state.conversation && state.conversation.id !== snapshot.conversation.id)
      throw new SynchronizationError('invalid_output');
    if (snapshot.eventCursor < state.eventCursor)
      throw new SynchronizationError('stale_snapshot', true);
    const runs = [...snapshot.queuedRuns, ...(snapshot.activeRun ? [snapshot.activeRun] : [])];
    if (runs.some(run => run.conversationId !== snapshot.conversation.id))
      throw new SynchronizationError('invalid_output');
    return {
      ...state,
      conversation: snapshot.conversation,
      messages: index(snapshot.recentMessages),
      runs: index(runs),
      activeRunId: snapshot.activeRun?.id ?? null,
      queuedRunIds: snapshot.queuedRuns.map(run => run.id),
      interactions: index(snapshot.unresolvedInteractions),
      pendingClientActions: Object.fromEntries(
        snapshot.pendingClientActions.map(action => [action.toolCall.id, action])
      ),
      eventCursor: snapshot.eventCursor,
      historyCursor: snapshot.historyCursor,
    };
  }
  const { sequence, conversationId, event } = action.envelope;
  if (conversationId !== state.conversation?.id) throw new SynchronizationError('invalid_output');
  if (sequence <= state.eventCursor) return state;
  if (sequence !== state.eventCursor + 1) throw new SynchronizationError('event_gap', true);
  const next = { ...state, eventCursor: sequence };
  switch (event.type) {
    case 'conversation':
      if (event.conversation.id !== conversationId)
        throw new SynchronizationError('invalid_output');
      return { ...next, conversation: event.conversation };
    case 'message':
      return { ...next, messages: { ...state.messages, [event.message.id]: event.message } };
    case 'run': {
      const run = event.run;
      if (run.conversationId !== conversationId) throw new SynchronizationError('invalid_output');
      return {
        ...next,
        runs: { ...state.runs, [run.id]: run },
        activeRunId: ['running', 'waiting', 'stopping'].includes(run.state.status)
          ? run.id
          : state.activeRunId === run.id
            ? null
            : state.activeRunId,
        queuedRunIds:
          run.state.status === 'queued'
            ? state.queuedRunIds.includes(run.id)
              ? state.queuedRunIds
              : [...state.queuedRunIds, run.id]
            : state.queuedRunIds.filter(id => id !== run.id),
      };
    }
    case 'interaction':
      return {
        ...next,
        interactions: { ...state.interactions, [event.interaction.id]: event.interaction },
      };
    case 'client_action': {
      const pendingClientActions = { ...state.pendingClientActions };
      if (event.action) {
        if (event.action.toolCall.id !== event.toolCallId)
          throw new SynchronizationError('invalid_output');
        pendingClientActions[event.toolCallId] = event.action;
      } else delete pendingClientActions[event.toolCallId];
      return { ...next, pendingClientActions };
    }
  }
}
