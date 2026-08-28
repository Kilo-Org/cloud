import { afterEach, expect, it, vi } from 'vitest';
import type { ReadInput } from './commands';
import {
  SnapshotSchema,
  type EventEnvelope,
  type Message,
  type Run,
  type Snapshot,
  type ToolCall,
} from './contracts';
import { createHarnessStore, type HarnessStore, type HarnessTransport } from './resume';
import { selectMessages } from './state';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const conversation = {
  id: id(1),
  ownerUserId: 'owner',
  context: { type: 'personal' as const },
  permissionMode: 'ask' as const,
  permissionRevision: 0,
};
const call: ToolCall = {
  id: id(5),
  runId: id(2),
  name: 'app.notifications',
  definitionVersion: '1',
  arguments: {},
  context: conversation.context,
  effect: 'side_effect',
  executionTarget: { kind: 'client', clientId: id(4) },
  approval: null,
  state: 'waiting',
  result: null,
};
const run: Run = {
  id: id(2),
  conversationId: id(1),
  inputMessageId: id(7),
  originClientId: id(4),
  modelId: 'model',
  state: { status: 'waiting', waiting: { reason: 'approval', toolCallId: call.id } },
};
const interaction = { id: id(6), kind: 'approval' as const, toolCall: call, resolution: null };
const action = { toolCall: call, grant: null, reason: 'locked' as const };
const message: Message = {
  id: id(7),
  role: 'assistant',
  content: 'Partial answer',
  createdAt: '2026-08-28T07:00:00.000Z',
  clientId: null,
  provenance: 'harness',
  protocolVersion: 1,
  runId: run.id,
  incomplete: true,
  parts: [
    { type: 'text', text: 'Partial answer' },
    { type: 'tool_call', toolCall: call },
    { type: 'citation', title: 'Source', url: 'https://example.com/source' },
  ],
};
const snapshot = (changes: Partial<Snapshot> = {}): Snapshot =>
  SnapshotSchema.parse({
    protocolVersion: 1,
    conversation,
    recentMessages: [message],
    activeRun: run,
    queuedRuns: [{ ...run, id: id(3), state: { status: 'queued' } }],
    unresolvedInteractions: [interaction],
    pendingClientActions: [action],
    eventCursor: 10,
    historyCursor: 'older',
    ...changes,
  });
const event = (sequence: number, payload: EventEnvelope['event']): EventEnvelope => ({
  protocolVersion: 1,
  conversationId: conversation.id,
  sequence,
  event: payload,
});
const completed: Run = { ...run, state: { status: 'completed' } };
const answer: Message = {
  ...message,
  content: 'Final answer',
  incomplete: false,
  parts: [{ type: 'text', text: 'Final answer' }, message.parts[2]],
};
const stores: HarnessStore[] = [];
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  vi.useRealTimers();
});
function source() {
  const listeners = new Set<() => void>();
  return {
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: () => listeners.forEach(listener => listener()),
  };
}
function setup(initial = snapshot()) {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const backend: HarnessTransport & {
    snapshot: unknown;
    pages: unknown[];
    events: EventEnvelope[];
    history: unknown;
    error: unknown;
    requests: ReadInput[];
  } = {
    snapshot: initial,
    pages: [],
    events: [],
    history: { messages: [], historyCursor: null },
    error: undefined,
    requests: [],
    read: async input => {
      backend.requests.push(input);
      if (backend.error) throw backend.error;
      if (input.type === 'getSnapshot') return backend.snapshot;
      if (input.type === 'getHistory') return backend.history;
      if (input.type === 'getEvents')
        return (
          backend.pages.shift() ?? {
            status: 'events',
            events: backend.events.filter(item => item.sequence > input.after),
          }
        );
      throw new Error('Unexpected read');
    },
  };
  const journal = source(),
    bridge = source();
  const open = () => {
    const store = createHarnessStore({
      conversationId: conversation.id,
      clientId: id(4),
      transport: backend,
      journal,
      bridge,
      clock: {
        now: () => Date.now(),
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
    });
    stores.push(store);
    return store;
  };
  return { backend, journal, bridge, open, store: open() };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => {
    resolve = done;
  });
  return { promise, resolve: (value: unknown) => resolve(value) };
}

it('bootstraps one atomic snapshot and advances settings, queue, and structured messages after its cursor', async () => {
  const { store, backend } = setup();
  backend.events = [
    event(9, { type: 'message', message: { ...message, content: 'Obsolete' } }),
    event(11, {
      type: 'conversation',
      conversation: { ...conversation, permissionMode: 'yolo', permissionRevision: 1 },
    }),
    event(12, { type: 'run', run: completed }),
    event(13, { type: 'run', run: { ...run, id: id(3), state: { status: 'running' } } }),
    event(14, { type: 'message', message: answer }),
  ];
  await store.refresh();
  const state = store.getSnapshot();
  expect(state.conversation).toMatchObject({ permissionMode: 'yolo', permissionRevision: 1 });
  expect(state.activeRunId).toBe(id(3));
  expect(state.queuedRunIds).toEqual([]);
  expect(state.runs[run.id].state).toEqual({ status: 'completed' });
  expect(selectMessages(state)).toEqual([answer]);
  expect(state.interactions[interaction.id].toolCall).toEqual(call);
  expect(state.pendingClientActions[call.id]).toEqual(action);
  expect(state.connection.status).toBe('connected');
  expect(backend.requests[1]).toMatchObject({ type: 'getEvents', after: 10 });
});

it('drops replayed sequences without reviving resolved work or replacing completed text with partial text', async () => {
  const { store, backend } = setup();
  const resolved = {
    ...interaction,
    resolution: { interactionId: interaction.id, commandId: id(20), decision: 'approve' as const },
  };
  backend.events = [
    event(11, { type: 'message', message: answer }),
    event(12, { type: 'run', run: completed }),
    event(13, { type: 'interaction', interaction: resolved }),
    event(14, { type: 'client_action', toolCallId: call.id, action: null }),
  ];
  await store.refresh();
  backend.pages.push({
    status: 'events',
    events: [
      event(11, { type: 'message', message }),
      event(12, { type: 'run', run }),
      event(13, { type: 'interaction', interaction }),
      event(14, { type: 'client_action', toolCallId: call.id, action }),
    ],
  });
  await store.refresh();
  const state = store.getSnapshot();
  expect(selectMessages(state)).toEqual([answer]);
  expect(state.runs[run.id].state.status).toBe('completed');
  expect(state.activeRunId).toBeNull();
  expect(state.interactions[interaction.id]).toEqual(resolved);
  expect(state.pendingClientActions).toEqual({});
  expect(state.eventCursor).toBe(14);
});

it.each(['gap', 'out-of-order', 'expired'] as const)(
  'replaces a %s cursor without applying unverified terminal events',
  async kind => {
    const { store, backend } = setup();
    await store.refresh();
    const observed: string[] = [];
    store.subscribe(() => {
      observed.push(store.getSnapshot().runs[run.id]?.state.status);
    });
    backend.pages.push(
      kind === 'expired'
        ? { status: 'cursor_expired' }
        : {
            status: 'events',
            events: [
              event(12, { type: 'run', run: completed }),
              ...(kind === 'out-of-order' ? [event(11, { type: 'run', run })] : []),
            ],
          }
    );
    backend.snapshot = snapshot({ eventCursor: 20, recentMessages: [] });
    backend.events = [
      event(21, { type: 'conversation', conversation: { ...conversation, permissionRevision: 2 } }),
    ];
    await store.refresh();
    const state = store.getSnapshot();
    expect(state.eventCursor).toBe(21);
    expect(state.connection.status).toBe('connected');
    expect(state.conversation?.permissionRevision).toBe(2);
    expect(state.interactions[interaction.id]).toEqual(interaction);
    expect(state.pendingClientActions[call.id]).toEqual(action);
    expect(state.queuedRunIds).toEqual([id(3)]);
    expect(observed).not.toContain('completed');
  }
);

it('preserves pending work through empty history and does not infer a terminal run from absent snapshot records', async () => {
  const { store, backend } = setup(snapshot({ recentMessages: [] }));
  await store.refresh();
  await store.loadHistory();
  expect(store.getSnapshot()).toMatchObject({
    messages: {},
    historyCursor: null,
    activeRunId: run.id,
    queuedRunIds: [id(3)],
    interactions: { [interaction.id]: interaction },
    pendingClientActions: { [call.id]: action },
  });
  backend.pages.push({ status: 'cursor_expired' });
  backend.snapshot = snapshot({
    eventCursor: 20,
    activeRun: null,
    queuedRuns: [],
    unresolvedInteractions: [],
    pendingClientActions: [],
  });
  await store.refresh();
  expect(store.getSnapshot().runs).toEqual({});
  expect(store.getSnapshot().activeRunId).toBeNull();
  expect(store.getSnapshot().interactions).toEqual({});
  expect(store.getSnapshot().pendingClientActions).toEqual({});
});

it('merges older history without overwriting live messages, tools, citations, or pending interactions', async () => {
  const { store, backend } = setup();
  await store.refresh();
  const older = {
    id: id(8),
    role: 'user',
    content: 'Older question',
    createdAt: '2026-08-27T07:00:00.000Z',
  };
  backend.history = {
    messages: [older, { ...message, content: 'Stale history' }],
    historyCursor: null,
  };
  await store.loadHistory();
  const state = store.getSnapshot();
  expect(selectMessages(state).map(item => item.content)).toEqual([
    'Older question',
    'Partial answer',
  ]);
  expect(state.messages[message.id]).toEqual(message);
  expect(state.interactions[interaction.id]).toEqual(interaction);
  expect(state.pendingClientActions[call.id]).toEqual(action);
  expect(state.eventCursor).toBe(10);
});

it.each(['replacement', 'blocked'])(
  'ignores late history after %s despite an unchanged history cursor',
  async kind => {
    const { store, backend } = setup();
    await store.refresh();
    const late = deferred();
    backend.history = late.promise;
    const loading = store.loadHistory();
    if (kind === 'replacement') {
      backend.pages.push({ status: 'cursor_expired' });
      backend.snapshot = snapshot({ eventCursor: 20, recentMessages: [] });
    } else backend.error = { code: 'access_revoked', message: 'Access denied', retryable: false };
    await store.refresh();
    const page = { messages: [{ ...message, id: id(11) }], historyCursor: null };
    late.resolve(page);
    await loading;
    expect(store.getSnapshot().messages).toEqual(
      kind === 'replacement' ? {} : { [message.id]: message }
    );
    expect(store.getSnapshot().historyCursor).toBe('older');
    expect(store.getSnapshot().interactions[interaction.id]).toEqual(interaction);
    if (kind === 'blocked') {
      backend.error = undefined;
      backend.history = page;
      await store.loadHistory();
      expect(store.getSnapshot().messages[id(11)]).toBeUndefined();
    }
  }
);

it('reconnects with bounded backoff while retaining run state and applying backend completion', async () => {
  const { store, backend } = setup();
  await store.refresh();
  backend.error = new Error('Network disconnected');
  await vi.advanceTimersByTimeAsync(1000);
  expect(store.getSnapshot().connection).toMatchObject({ status: 'retrying', retryAt: 3000 });
  expect(store.getSnapshot().runs[run.id]).toEqual(run);
  expect(store.getSnapshot().interactions[interaction.id]).toEqual(interaction);
  await vi.advanceTimersByTimeAsync(1000);
  expect(store.getSnapshot().connection).toMatchObject({ status: 'retrying', retryAt: 5000 });
  backend.error = undefined;
  backend.events = [
    event(11, { type: 'message', message: answer }),
    event(12, { type: 'run', run: completed }),
  ];
  await vi.advanceTimersByTimeAsync(2000);
  expect(store.getSnapshot().connection.status).toBe('connected');
  expect(store.getSnapshot().runs[run.id]).toEqual(completed);
  expect(selectMessages(store.getSnapshot())).toEqual([answer]);
});

it.each(['unsupported_protocol', 'invalid_output', 'access_revoked', 'retired'])(
  'blocks %s without a terminal run or automatic retry',
  async code => {
    const { store, backend } = setup();
    await store.refresh();
    if (code === 'unsupported_protocol')
      backend.pages.push({
        status: 'events',
        events: [{ ...event(11, { type: 'run', run: completed }), protocolVersion: 2 }],
      });
    else if (code === 'invalid_output')
      backend.pages.push({
        status: 'events',
        events: [{ ...event(11, { type: 'run', run: completed }), conversationId: id(99) }],
      });
    else backend.error = { code, message: 'Access denied', retryable: false };
    await store.refresh();
    expect(store.getSnapshot().connection).toMatchObject({
      status: 'blocked',
      error: { code, retryable: false },
    });
    backend.error = undefined;
    backend.events = [event(11, { type: 'run', run: completed })];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getSnapshot().runs[run.id]).toEqual(run);
    expect(store.getSnapshot().pendingClientActions[call.id]).toEqual(action);
    expect(vi.getTimerCount()).toBe(0);
  }
);

it.each([
  [{ protocolVersion: 2 }, 'unsupported_protocol'],
  [{ conversation: { ...conversation, id: id(99) } }, 'invalid_output'],
  [{ activeRun: { ...run, conversationId: id(99) } }, 'invalid_output'],
  [
    { queuedRuns: [{ ...run, conversationId: id(99), state: { status: 'queued' } }] },
    'invalid_output',
  ],
  [{ unresolvedInteractions: undefined }, 'invalid_output'],
])(
  'rejects invalid bootstrap data without publishing a partial snapshot: %j',
  async (changes, code) => {
    const { store, backend } = setup();
    backend.snapshot = { ...snapshot(), ...changes };
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({
      conversation: null,
      messages: {},
      eventCursor: 0,
      connection: { status: 'blocked', error: { code } },
    });
  }
);

it('backs off repeated gaps and refuses a replacement snapshot that moves the cursor backward', async () => {
  const { store, backend } = setup();
  await store.refresh();
  backend.pages.push({ status: 'cursor_expired' });
  backend.snapshot = snapshot({ eventCursor: 9, recentMessages: [] });
  await store.refresh();
  expect(store.getSnapshot().connection).toMatchObject({
    status: 'retrying',
    error: { code: 'stale_snapshot' },
  });
  expect(store.getSnapshot().messages[message.id]).toEqual(message);
  backend.snapshot = snapshot();
  backend.pages.push({ status: 'cursor_expired' }, { status: 'cursor_expired' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(store.getSnapshot().connection.status).toBe('retrying');
  expect(store.getSnapshot().eventCursor).toBe(10);
  expect(vi.getTimerCount()).toBe(1);
});

it('retains question and device waits outside history without treating a dismissal as run completion', async () => {
  const { store, backend } = setup();
  const question = {
    ...interaction,
    id: id(9),
    kind: 'question' as const,
    questionId: 'format',
    toolCall: {
      ...call,
      id: id(10),
      name: 'test.question',
      executionTarget: { kind: 'interaction' as const },
    },
  };
  const waiting: Run = {
    ...run,
    state: { status: 'waiting', waiting: { reason: 'question', toolCallId: question.toolCall.id } },
  };
  backend.events = [
    event(11, { type: 'interaction', interaction: question }),
    event(12, {
      type: 'client_action',
      toolCallId: call.id,
      action: { ...action, reason: 'background' },
    }),
    event(13, { type: 'run', run: waiting }),
  ];
  await store.refresh();
  await store.loadHistory();
  expect(store.getSnapshot().interactions[question.id]).toEqual(question);
  expect(store.getSnapshot().pendingClientActions[call.id]).toEqual({
    ...action,
    reason: 'background',
  });
  backend.events.push(
    event(14, {
      type: 'interaction',
      interaction: { ...question, resolution: { kind: 'dismiss' } },
    })
  );
  await store.refresh();
  expect(store.getSnapshot().interactions[question.id].resolution).toEqual({ kind: 'dismiss' });
  expect(store.getSnapshot().runs[run.id]).toEqual(waiting);
  expect(store.getSnapshot().activeRunId).toBe(run.id);
});

it('keeps queue order when a queued run receives another event', async () => {
  const { store, backend } = setup();
  backend.events = [
    event(11, { type: 'run', run: { ...run, id: id(9), state: { status: 'queued' } } }),
    event(12, { type: 'run', run: { ...run, id: id(3), state: { status: 'queued' } } }),
  ];
  await store.refresh();
  expect(store.getSnapshot().queuedRunIds).toEqual([id(3), id(9)]);
  expect(store.getSnapshot().activeRunId).toBe(run.id);
});

it.each(['transport', 'malformed'])(
  'retains the history cursor and pending records after a %s failure',
  async kind => {
    const { store, backend } = setup();
    await store.refresh();
    if (kind === 'transport')
      backend.error = { code: 'storage_unavailable', message: 'Retry', retryable: true };
    else backend.history = { messages: [], historyCursor: undefined };
    await expect(store.loadHistory()).rejects.toMatchObject({
      code: kind === 'transport' ? 'storage_unavailable' : 'invalid_output',
      retryable: kind === 'transport',
    });
    expect(store.getSnapshot().historyCursor).toBe('older');
    expect(selectMessages(store.getSnapshot())).toEqual([message]);
    expect(store.getSnapshot().interactions[interaction.id]).toEqual(interaction);
    expect(store.getSnapshot().pendingClientActions[call.id]).toEqual(action);
  }
);

it('uses journal and bridge hints to publish shared state before the next poll', async () => {
  const { store, backend, journal, bridge } = setup();
  await store.refresh();
  const observed: string[] = [];
  const unsubscribe = store.subscribe(() => {
    observed.push(store.getSnapshot().messages[message.id].content);
  });
  backend.events.push(event(11, { type: 'message', message: answer }));
  journal.emit();
  await vi.advanceTimersByTimeAsync(0);
  expect(observed.at(-1)).toBe('Final answer');
  unsubscribe();
  backend.events.push(
    event(12, { type: 'message', message: { ...answer, content: 'Next answer' } })
  );
  bridge.emit();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getSnapshot().messages[message.id].content).toBe('Next answer');
  expect(observed.at(-1)).toBe('Final answer');
});

it('disposes subscriptions, ignores late responses, and lets a new host observe backend completion', async () => {
  const { store, backend, journal, bridge, open } = setup();
  await store.refresh();
  const late = deferred();
  backend.pages.push(late.promise);
  const polling = store.refresh();
  await vi.advanceTimersByTimeAsync(0);
  store.dispose();
  backend.snapshot = snapshot({
    eventCursor: 12,
    recentMessages: [answer],
    activeRun: null,
    queuedRuns: [],
    unresolvedInteractions: [],
    pendingClientActions: [],
  });
  late.resolve({
    status: 'events',
    events: [
      event(11, { type: 'message', message: answer }),
      event(12, { type: 'run', run: completed }),
    ],
  });
  await polling;
  expect(store.getSnapshot().connection.status).toBe('disposed');
  expect(store.getSnapshot().runs[run.id]).toEqual(run);
  expect(selectMessages(store.getSnapshot())).toEqual([message]);
  expect(journal.listeners.size + bridge.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const reopened = open();
  await reopened.refresh();
  expect(selectMessages(reopened.getSnapshot())).toEqual([answer]);
  expect(reopened.getSnapshot().activeRunId).toBeNull();
});
