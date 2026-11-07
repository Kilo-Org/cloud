import {
  NativeSyncClient,
  NativeSyncError,
  type NativeSocket,
  type NativeSessionState,
  type NativePresenceState,
} from './native-sync';
import { fetchNativeSnapshot, type NativeSnapshot } from './native-sync-snapshot';
import type * as NativeSnapshotModule from './native-sync-snapshot';
import { kilo2AssetKey } from './kilo2-source-messages';
import { readNativeConversation } from './native-conversation-source';
import { z } from 'zod';

jest.mock('./native-sync-snapshot', () => ({
  ...jest.requireActual<typeof NativeSnapshotModule>('./native-sync-snapshot'),
  fetchNativeSnapshot: jest.fn(),
}));
const fixtureNativeBodySchema = z
  .object({ data: z.object({ data: z.record(z.string(), z.unknown()) }).passthrough() })
  .passthrough();
const snapshot = jest.mocked(fetchNativeSnapshot);
class FakeSocket implements NativeSocket {
  static sockets: FakeSocket[] = [];
  readyState = 1;
  onopen: NativeSocket['onopen'] = null;
  onmessage: NativeSocket['onmessage'] = null;
  onclose: NativeSocket['onclose'] = null;
  onerror: NativeSocket['onerror'] = null;
  sent: Record<string, unknown>[] = [];
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    FakeSocket.sockets.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, { code: 1006 } as CloseEvent);
  }
  frame(type: string, body: unknown, seq = 0, channel = 'control') {
    const parsed = fixtureNativeBodySchema.safeParse(body);
    if (channel === 'events' && parsed.success) {
      const wrapper = parsed.data;
      body = {
        ...wrapper,
        data: {
          ...wrapper.data,
          id: `evt_${seq}`,
          type,
          created: seq,
          data: {
            sessionID: 'ses_a',
            ...(type === 'session.step.started'
              ? { started: seq, agent: 'build', model: { id: 'model', providerID: 'kilo' } }
              : {}),
            ...wrapper.data.data,
          },
        },
      };
    }
    this.onmessage?.call(
      this as unknown as WebSocket,
      {
        data: JSON.stringify({ v: 1, channel, seq, type, body, from: 'server', at: Date.now() }),
      } as MessageEvent
    );
  }
}
function connectedSocket(index = 0) {
  const socket = FakeSocket.sockets[index];
  if (!socket) throw new Error(`Expected native socket ${index}`);
  return socket;
}
const hello = (runnerConnected = true) => ({
  runnerConnected,
  reconnectAfterMs: 1000,
  reauthAt: new Date(Date.now() + 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 90_000).toISOString(),
});
async function flush() {
  for (let index = 0; index < 25; index++) await Promise.resolve();
}
function fixture() {
  const calls: {
    path: string;
    body: Record<string, unknown>;
    authorization: string | undefined;
  }[] = [];
  const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ path, body, authorization: headers?.Authorization });
    if (path.endsWith('/exchange'))
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    if (path.endsWith('ticket'))
      return Response.json({
        ticket: 'private-ticket',
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      });
    return Response.json({ commandID: body.commandID ?? 'known', status: 'queued' });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  return { client, calls, fetcher };
}
const sessionMetadata = {
  id: 'ses_a',
  origin: { directory: '/fixture' },
  time: { created: 1, updated: 1 },
};
beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.sockets = [];
  snapshot.mockResolvedValue({
    position: 0,
    revision: 1,
    session: sessionMetadata,
    entities: [],
    messages: [],
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

test('tickets use the subprotocol and credential exchange, never URL credentials', async () => {
  const { client, calls } = fixture();
  const connection = client.connectSession('ses_a', () => {});
  await flush();
  const socket = connectedSocket();
  expect(socket.url).toBe('wss://sync.test/v1/sessions/ses_a/live');
  expect(socket.protocols).toEqual(['kilo-session-ticket.private-ticket']);
  expect(calls[0]?.authorization).toBe('Bearer kilo-credential');
  expect(calls[0]?.body).toEqual({ version: 1 });
  expect(calls[1]?.authorization).toBe('Bearer grant');
  connection.close();
});

test('exchanges a versioned organization grant for organization sessions', async () => {
  const { client, calls } = fixture();
  const connection = client.connectSession('ses_a', () => {}, 'organization-1');
  await flush();
  expect(calls[0]?.body).toEqual({ version: 1, organizationID: 'organization-1' });
  connection.close();
});

test('canonical snapshot reads use the selected organization grant and caller cancellation', async () => {
  const controller = new AbortController();
  const expected: NativeSnapshot = { position: 4, revision: 2, messages: [], entities: [] };
  snapshot.mockImplementationOnce(async (request, sessionID, signal) => {
    expect(sessionID).toBe('ses_canonical');
    expect(signal).toBe(controller.signal);
    await request(`/v1/sessions/${sessionID}`, { signal });
    return expected;
  });
  const { client, calls } = fixture();
  await expect(
    client.getSnapshot('ses_canonical', 'organization-1', controller.signal)
  ).resolves.toBe(expected);
  expect(calls[0]?.body).toEqual({ version: 1, organizationID: 'organization-1' });
  expect(calls[1]).toMatchObject({
    path: '/v1/sessions/ses_canonical',
    authorization: 'Bearer grant',
  });
});

test('snapshots before subscribe, ordered sparse replay dedupes and reconnect resumes', async () => {
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 10);
  await flush();
  expect(socket.sent).toContainEqual({ type: 'subscribe', afterSeq: 10 });
  socket.frame(
    'session.step.started',
    { syncPosition: 1, data: { data: { assistantMessageID: 'msg_m1' } } },
    12,
    'events'
  );
  socket.frame(
    'session.text.delta',
    {
      syncPosition: 2,
      data: { data: { assistantMessageID: 'msg_m1', ordinal: 0, delta: 'hello' } },
    },
    15,
    'events'
  );
  socket.frame(
    'session.text.delta',
    {
      syncPosition: 2,
      data: { data: { assistantMessageID: 'msg_m1', ordinal: 0, delta: 'duplicate' } },
    },
    15,
    'events'
  );
  await flush();
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'hello' }]);
  socket.close();
  await jest.advanceTimersByTimeAsync(2001);
  await flush();
  const reconnected = connectedSocket(1);
  reconnected.frame('hello', hello(), 20);
  await flush();
  expect(reconnected.sent).toContainEqual({ type: 'subscribe', afterSeq: 15 });
  expect(snapshot).toHaveBeenCalledTimes(1);
  connection.close();
});

test('reset refetches durable state and explicitly resubscribes from reset high-water', async () => {
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  await flush();
  snapshot.mockResolvedValueOnce({
    position: 30,
    session: sessionMetadata,
    revision: 4,
    entities: [],
    messages: [
      {
        message: { id: 'msg_durable', type: 'user', text: 'restored', time: { created: 1 } },
        seq: 1,
      },
    ],
  });
  socket.frame('reset_required', { seq: 40 }, 40);
  await flush();
  expect(state?.messages[0]?.message.text).toBe('restored');
  expect(socket.sent).toContainEqual({ type: 'subscribe', afterSeq: 40 });
  connection.close();
});

test('reauthorizes proactively and exchanges an expired grant again', async () => {
  const { client, calls } = fixture();
  const connection = client.connectSession('ses_a', () => {});
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', { ...hello(), reauthAt: new Date(Date.now() + 280_000).toISOString() });
  await flush();
  await jest.advanceTimersByTimeAsync(280_000);
  await flush();
  expect(calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(2);
  expect(socket.sent).toContainEqual({ type: 'reauth', ticket: 'private-ticket' });
  connection.close();
});

test('rejects offline live-only commands and queues opt-in prompts with TTL and status reads', async () => {
  const { client, calls } = fixture();
  const connection = client.connectSession('ses_a', () => {});
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(false));
  await flush();
  await expect(connection.sendMessage('no queue')).rejects.toMatchObject({
    code: 'runner_offline',
  });
  await expect(connection.interrupt()).rejects.toMatchObject({ code: 'active_run_unknown' });
  const commandID = await connection.sendMessage('queue me', { queueIfOffline: true, ttlMs: 5000 });
  expect(calls.find(call => call.path.endsWith('/commands'))?.body).toMatchObject({
    channel: 'commands',
    commandID,
    liveOnly: false,
    ttlMs: 5000,
    type: 'send_message',
  });
  expect(await connection.getCommandStatus(commandID)).toBe('queued');
  connection.close();
});

test('approvals and abort carry the current incarnation/run and liveOnly', async () => {
  const { client, calls } = fixture();
  const connection = client.connectSession('ses_a', () => {});
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  await flush();
  socket.frame(
    'permission.asked',
    {
      incarnation: 'runner-1',
      runID: 'run-2',
      data: { data: { id: 'approval-3', action: 'shell', resources: ['pwd'] } },
    },
    1,
    'events'
  );
  await flush();
  await connection.respondPermission('approval-3', 'once');
  expect(calls.find(call => call.body.type === 'permission_respond')?.body).toMatchObject({
    liveOnly: true,
    body: { incarnation: 'runner-1', runID: 'run-2', requestID: 'approval-3', reply: 'once' },
  });
  await connection.interrupt();
  expect(calls.find(call => call.body.type === 'interrupt')?.body.liveOnly).toBe(true);
  socket.frame('runner_status', { runnerConnected: false });
  await flush();
  await expect(connection.respondPermission('approval-3', 'once')).rejects.toMatchObject({
    code: 'active_run_unknown',
  });
  connection.close();
});

test('clear stays local, does not prevent new messages, and rejects unsafe slash commands', async () => {
  const { client, calls } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  await flush();
  socket.frame(
    'session.step.started',
    { syncPosition: 1, data: { data: { assistantMessageID: 'msg_old' } } },
    1,
    'events'
  );
  await flush();
  await connection.sendCommand('/clear');
  expect(state?.messages).toEqual([]);
  expect(calls.filter(call => call.path.endsWith('/commands'))).toEqual([]);
  socket.frame(
    'session.step.started',
    { syncPosition: 2, data: { data: { assistantMessageID: 'msg_new' } } },
    2,
    'events'
  );
  await flush();
  expect(state?.messages.map(item => item.message.id)).toEqual(['msg_new']);
  await expect(connection.sendCommand('/delete')).rejects.toMatchObject({ code: 'unsafe_command' });
  connection.close();
});

test('presence routes replies to exact calls and treats 10-second timeout as unknown', async () => {
  const { client } = fixture();
  let state: NativePresenceState | undefined;
  const connection = client.connectPresence(value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  socket.frame('instances', {
    instances: [
      {
        instanceID: 'host',
        tenant: { type: 'user', id: 'u' },
        online: true,
        advertisement: { name: 'Host', projectName: 'Demo', kind: 'remote', sessions: [] },
      },
    ],
  });
  await flush();
  expect(state?.instances).toHaveLength(1);
  const first = connection.command('host', 'list_models');
  const commandID = socket.sent.find(frame => frame.type === 'list_models')?.commandID;
  socket.frame('reply', { commandID, instanceID: 'other', payload: 'wrong' });
  await flush();
  socket.frame('reply', { commandID, instanceID: 'host', payload: { models: [] } });
  await flush();
  await expect(first).resolves.toMatchObject({ status: 'replied', body: { models: [] } });
  const second = connection.command('host', 'create_session');
  await jest.advanceTimersByTimeAsync(10_000);
  await expect(second).resolves.toMatchObject({ status: 'unknown' });
  connection.close();
});

test('equal-position ephemeral deltas fill incomplete snapshots and terminal state recovers durable history', async () => {
  snapshot.mockResolvedValueOnce({
    position: 10,
    session: sessionMetadata,
    revision: 1,
    entities: [],
    messages: [
      {
        message: { id: 'msg_m', type: 'assistant', time: { created: 1 } },
        seq: 1,
        incomplete: true,
      },
    ],
  });
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  await flush();
  socket.frame(
    'session.text.delta',
    {
      syncPosition: 10,
      data: { data: { assistantMessageID: 'msg_m', ordinal: 0, delta: 'live' } },
    },
    1,
    'events'
  );
  await flush();
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'live' }]);
  expect(state?.messages[0]?.incomplete).toBe(true);
  snapshot.mockResolvedValueOnce({
    position: 20,
    session: sessionMetadata,
    revision: 2,
    entities: [],
    messages: [
      {
        message: {
          id: 'msg_m',
          type: 'assistant',
          time: { created: 1 },
          content: [{ type: 'text', text: 'full live' }],
        },
        seq: 1,
        partOrdinals: [2],
      },
    ],
  });
  socket.frame(
    'session.execution.succeeded',
    { syncPosition: 20, data: { data: {} } },
    2,
    'events'
  );
  await flush();
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'full live' }]);
  expect(state?.messages[0]?.incomplete).toBeUndefined();
  connection.close();
});

test('first-attachment state supplies identity and quiet reconnect retains it', async () => {
  const { client, calls } = fixture();
  const connection = client.connectSession('ses_a', () => {});
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  await flush();
  socket.frame(
    'remote.state',
    {
      incarnation: 'runner',
      runID: 'run',
      running: true,
      pending: { permissions: [], questions: [] },
    },
    1,
    'events'
  );
  await flush();
  socket.close();
  await jest.advanceTimersByTimeAsync(2001);
  await flush();
  connectedSocket(1).frame('hello', hello(), 1);
  await flush();
  await connection.respondPermission('existing', 'reject');
  expect(calls.find(call => call.body.type === 'permission_respond')?.body.body).toMatchObject({
    incarnation: 'runner',
    runID: 'run',
    requestID: 'existing',
  });
  connection.close();
});

test('unreadable pending inventory clears controls without blocking later ordered frames', async () => {
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  await flush();
  socket.frame(
    'remote.state',
    {
      incarnation: 'runner',
      runID: 'run',
      pending: {
        permissions: [{ requestID: 'old', tool: 'edit', summary: 'file' }],
        questions: [],
      },
    },
    1,
    'events'
  );
  await flush();
  expect(state?.pending.permissions.map(item => item.id)).toEqual(['old']);
  socket.frame('remote.state', { incarnation: 'runner', runID: 'run', pending: null }, 2, 'events');
  await flush();
  expect(state?.pending).toEqual({ permissions: [], questions: [] });
  socket.frame(
    'permission.asked',
    { incarnation: 'runner', runID: 'run', data: { data: { id: 'invalid' } } },
    3,
    'events'
  );
  socket.frame(
    'remote.state',
    {
      incarnation: 'runner',
      runID: 'run',
      pending: {
        permissions: [{ requestID: 'new', tool: 'edit', summary: 'file' }],
        questions: [],
      },
    },
    4,
    'events'
  );
  await flush();
  expect(state?.pending.permissions.map(item => item.id)).toEqual(['new']);
  expect(state?.connection).toBe('connected');
  expect(FakeSocket.sockets).toHaveLength(1);
  connection.close();
});

const incomplete = (position: number) => ({
  position,
  session: sessionMetadata,
  revision: 1,
  entities: [],
  messages: [
    { message: { id: 'msg_m', type: 'assistant', time: { created: 1 } }, seq: 1, incomplete: true },
  ],
});
const complete = (position: number) => ({
  position,
  session: sessionMetadata,
  revision: 2,
  entities: [],
  messages: [
    {
      message: {
        id: 'msg_m',
        type: 'assistant',
        time: { created: 1 },
        content: [{ type: 'text', text: 'done' }],
      },
      seq: 1,
    },
  ],
});

test('attach to an idle connected runner retries an incomplete snapshot within a bound', async () => {
  snapshot.mockResolvedValueOnce(incomplete(5)).mockResolvedValueOnce(complete(6));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello(true), 3);
  await flush();
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(state?.messages[0]?.incomplete).toBeUndefined();
  snapshot.mockResolvedValue(incomplete(7));
  connectedSocket().frame('reset_required', { seq: 9 }, 9);
  await flush();
  await jest.advanceTimersByTimeAsync(10_000);
  await flush();
  expect(snapshot).toHaveBeenCalledTimes(7);
  connection.close();
});

test('recovery runs beside live events and reapplies frames newer than its snapshot', async () => {
  snapshot.mockResolvedValueOnce(incomplete(5));
  let release: (value: NativeSnapshot) => void = () => {};
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(true), 3);
  await flush();
  const delta = (seq: number, syncPosition: number, text: string) =>
    socket.frame(
      'session.text.delta',
      { syncPosition, data: { data: { assistantMessageID: 'msg_m', ordinal: 0, delta: text } } },
      seq,
      'events'
    );
  delta(4, 5, 'live');
  await flush();
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'live' }]);
  snapshot.mockReturnValueOnce(
    new Promise<NativeSnapshot>(resolve => {
      release = resolve;
    })
  );
  await jest.advanceTimersByTimeAsync(250);
  expect(snapshot).toHaveBeenCalledTimes(2);
  delta(5, 7, ' more');
  await flush();
  release(complete(6));
  await flush();
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'done more' }]);
  connection.close();
});

test('a transient recovery read keeps the remaining attempts', async () => {
  snapshot
    .mockResolvedValueOnce(incomplete(5))
    .mockRejectedValueOnce(new NativeSyncError('HTTP 500', 500))
    .mockResolvedValueOnce(complete(6));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello(true), 3);
  await flush();
  await jest.advanceTimersByTimeAsync(800);
  await flush();
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(state?.messages[0]?.incomplete).toBeUndefined();
  connection.close();
});

test('a permanent recovery read failure stops recovery with an error', async () => {
  snapshot
    .mockResolvedValueOnce(incomplete(5))
    .mockRejectedValueOnce(new NativeSyncError('forbidden', 403));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello(true), 3);
  await flush();
  await jest.advanceTimersByTimeAsync(10_000);
  await flush();
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(state?.messages[0]?.incomplete).toBe(true);
  expect(state?.error).toBe('forbidden');
  connection.close();
});

test.each([
  ['deleted session', () => Object.assign(new Error('deleted'), { code: 'session_deleted' })],
  ['forbidden read', () => new NativeSyncError('forbidden', 403)],
])('a %s ends the connection without reconnecting', async (_name, failure) => {
  snapshot.mockRejectedValueOnce(failure());
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello());
  await flush();
  await jest.advanceTimersByTimeAsync(120_000);
  await flush();
  expect(FakeSocket.sockets).toHaveLength(1);
  expect(state?.connection).toBe('disconnected');
  connection.close();
});

test('a missing session snapshot stays retryable', async () => {
  snapshot.mockRejectedValueOnce(new NativeSyncError('session_not_found', 404));
  const { client } = fixture();
  const connection = client.connectSession('ses_a', () => {});
  await flush();
  connectedSocket().frame('hello', hello());
  await flush();
  await jest.advanceTimersByTimeAsync(2001);
  await flush();
  expect(FakeSocket.sockets).toHaveLength(2);
  connection.close();
});

test('frames queued behind a closing socket cannot renew or resubscribe it', async () => {
  let release: (value: NativeSnapshot) => void = () => {};
  snapshot.mockReturnValueOnce(
    new Promise<NativeSnapshot>(resolve => {
      release = resolve;
    })
  );
  const { client, calls } = fixture();
  const connection = client.connectSession('ses_a', () => {});
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 1);
  socket.frame('reset_required', { seq: 2 }, 2);
  socket.frame('reauthorized', hello(), 2);
  await flush();
  socket.close();
  release({ position: 0, revision: 1, entities: [], messages: [] });
  await flush();
  await jest.advanceTimersByTimeAsync(61_000);
  await flush();
  expect(socket.sent).toEqual([]);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(FakeSocket.sockets).toHaveLength(2);
  expect(calls.filter(call => call.path.endsWith('live-ticket'))).toHaveLength(2);
  connection.close();
});

test('binds the browser default fetch receiver', async () => {
  const { fetcher } = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = function (this: typeof globalThis, input, init) {
    if (this !== globalThis) throw new Error('Illegal invocation');
    return fetcher(input, init);
  };
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'credential',
    WebSocket: FakeSocket,
  });
  const connection = client.connectPresence(() => {});
  try {
    await flush();
    expect(FakeSocket.sockets).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    connection.close();
    globalThis.fetch = original;
  }
});

test('a replacement epoch reads and subscribes while its predecessor is held', async () => {
  let release: (value: NativeSnapshot) => void = () => {};
  let oldSignal: AbortSignal | undefined;
  snapshot.mockImplementationOnce((_request, _session, signal) => {
    oldSignal = signal;
    return new Promise(resolve => {
      release = resolve;
    });
  });
  snapshot.mockResolvedValueOnce(complete(20));
  const { client } = fixture();
  const listener = jest.fn();
  const connection = client.connectSession('ses_a', listener);
  await flush();
  connectedSocket().frame('hello', hello(), 10);
  await flush();
  connectedSocket().close();
  await jest.advanceTimersByTimeAsync(2001);
  const next = connectedSocket(1);
  next.frame('hello', hello(), 30);
  await flush();
  expect(oldSignal?.aborted).toBe(true);
  expect(next.sent).toContainEqual({ type: 'subscribe', afterSeq: 30 });
  const before = listener.mock.calls.length;
  release({
    ...complete(99),
    messages: [{ message: { id: 'old', type: 'user', text: 'old', time: { created: 1 } }, seq: 1 }],
  });
  await flush();
  expect(listener).toHaveBeenCalledTimes(before);
  expect(listener.mock.lastCall?.[0].messages).toEqual([
    {
      message: {
        id: 'msg_m',
        type: 'assistant',
        time: { created: 1 },
        content: [{ type: 'text', text: 'done' }],
      },
      seq: 1,
    },
  ]);
  expect(connectedSocket().sent).toEqual([]);
  connection.close();
});

test.each(['initial', 'recovery'])(
  'close cancels a held %s read and fences late results',
  async mode => {
    if (mode === 'recovery') snapshot.mockResolvedValueOnce(incomplete(5));
    let release: (value: NativeSnapshot) => void = () => {};
    let signal: AbortSignal | undefined;
    snapshot.mockImplementationOnce((_request, _session, ownedSignal) => {
      signal = ownedSignal;
      return new Promise(resolve => {
        release = resolve;
      });
    });
    const { client } = fixture();
    const listener = jest.fn();
    const connection = client.connectSession('ses_a', listener);
    await flush();
    const socket = connectedSocket();
    socket.frame('hello', hello(), 3);
    await flush();
    if (mode === 'recovery') await jest.advanceTimersByTimeAsync(250);
    if (mode === 'initial') socket.frame('reset_required', { seq: 9 }, 9);
    expect(signal?.aborted).toBe(false);
    connection.close();
    const before = listener.mock.calls.length;
    const sent = socket.sent.length;
    release(complete(20));
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(before);
    expect(socket.sent).toHaveLength(sent);
    expect(FakeSocket.sockets).toHaveLength(1);
  }
);

test.each([
  ['count', 0],
  ['bytes', 8000],
])('bounds held raw frames by %s and retires their read', async (_name, padding) => {
  let signal: AbortSignal | undefined;
  snapshot.mockImplementationOnce((_request, _session, ownedSignal) => {
    signal = ownedSignal;
    return new Promise(() => {});
  });
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 3);
  await flush();
  const offered = padding === 0 ? 12_000 : 300;
  for (let seq = 4; seq < offered + 4; seq++)
    socket.frame('session.status', { padding: 'x'.repeat(padding) }, seq, 'events');
  expect(socket.readyState).toBe(3);
  expect(signal?.aborted).toBe(true);
  expect(state?.events).toHaveLength(0);
  expect(state?.error).toContain('incomplete');
  connection.close();
});

test.each(['x'.repeat(262_144), '😀'.repeat(131_072)])(
  'an oversized inbound frame is rejected before parsing',
  async padding => {
    const { client } = fixture();
    let state: NativeSessionState | undefined;
    const connection = client.connectSession('ses_a', value => {
      state = value;
    });
    await flush();
    connectedSocket().frame('hello', hello(), 3);
    await flush();
    connectedSocket().frame('session.status', { padding }, 4, 'events');
    expect(connectedSocket().readyState).toBe(3);
    expect(state?.events).toHaveLength(0);
    expect(state?.error).toContain('frame exceeded the size limit');
    connection.close();
  }
);

test.each([
  ['count', 0],
  ['bytes', 8000],
])(
  'bounds subscribed recovery replay by %s without accepting the overflowing cursor',
  async (_name, padding) => {
    snapshot.mockResolvedValueOnce(incomplete(5));
    let signal: AbortSignal | undefined;
    snapshot.mockImplementationOnce((_request, _session, ownedSignal) => {
      signal = ownedSignal;
      return new Promise(() => {});
    });
    const { client } = fixture();
    let state: NativeSessionState | undefined;
    const connection = client.connectSession('ses_a', value => {
      state = value;
    });
    await flush();
    const socket = connectedSocket();
    socket.frame('hello', hello(), 3);
    await flush();
    await jest.advanceTimersByTimeAsync(250);
    let accepted = 3;
    const offered = padding === 0 ? 12_000 : 300;
    for (let seq = 4; seq < offered + 4; seq++) {
      socket.frame(
        'session.status',
        { syncPosition: 5, padding: 'x'.repeat(padding) },
        seq,
        'events'
      );
      await flush();
      if (socket.readyState === 1) accepted = seq;
    }
    expect(signal?.aborted).toBe(true);
    expect(accepted).toBeLessThanOrEqual(1027);
    await jest.advanceTimersByTimeAsync(2001);
    connectedSocket(1).frame('hello', hello(), 12_004);
    await flush();
    expect(connectedSocket(1).sent).toContainEqual({ type: 'subscribe', afterSeq: accepted });
    connectedSocket(1).frame('subscribed', { seq: 12_004 }, 12_004);
    await flush();
    expect(state?.error).toContain('incomplete');
    connection.close();
  }
);

test('available relay replay restores unique ordered deltas from the accepted cursor', async () => {
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const first = connectedSocket();
  first.frame('hello', hello(), 3);
  await flush();
  const event = (socket: FakeSocket, seq: number, ordinal: number, delta: string) =>
    socket.frame(
      'session.text.delta',
      { syncPosition: 0, data: { data: { assistantMessageID: 'msg_m', ordinal, delta } } },
      seq,
      'events'
    );
  first.frame(
    'session.step.started',
    { data: { data: { assistantMessageID: 'msg_m' } } },
    4,
    'events'
  );
  await flush();
  event(first, 5, 0, 'ten:5|');
  await flush();
  for (let seq = 6; seq <= 2000; seq++) event(first, seq, 1, `${seq}|`);
  await flush();
  const accepted = state?.events.at(-1)?.seq ?? 0;
  expect(accepted).toBe(6);
  await jest.advanceTimersByTimeAsync(2001);
  const next = connectedSocket(1);
  next.frame('hello', hello(), 2000);
  await flush();
  expect(next.sent).toContainEqual({ type: 'subscribe', afterSeq: accepted });
  for (let seq = accepted + 1; seq <= 2000; seq++) {
    event(next, seq, 1, `${seq}|`);
    await flush();
  }
  next.frame('subscribed', { seq: 2000 }, 2000);
  await flush();
  expect(state?.messages[0]?.message.content).toEqual([
    { type: 'text', text: 'ten:5|' },
    { type: 'text', text: Array.from({ length: 1995 }, (_, index) => `${index + 6}|`).join('') },
  ]);
  expect(state?.messages[0]?.partOrdinals).toBeUndefined();
  expect(state?.error).toBeUndefined();
  connection.close();
});

test('a reset keeps its integrity error through snapshots, reconnect and subscribed', async () => {
  snapshot.mockResolvedValue(complete(5));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello(), 3);
  await flush();
  connectedSocket().frame('reset_required', { seq: 50 }, 50);
  await flush();
  connectedSocket().frame('subscribed', { seq: 50 }, 50);
  await flush();
  expect(state?.error).toContain('incomplete');
  connectedSocket().close();
  await jest.advanceTimersByTimeAsync(2001);
  connectedSocket(1).frame('hello', hello(), 50);
  connectedSocket(1).frame('subscribed', { seq: 50 }, 50);
  await flush();
  expect(state?.connection).toBe('connected');
  expect(state?.error).toContain('incomplete');
  connection.close();
});

test.each([
  ['forbidden', () => new NativeSyncError('forbidden', 403)],
  ['deleted', () => Object.assign(new Error('deleted'), { code: 'session_deleted' })],
])('keeps a specific %s failure visible alongside an integrity gap', async (cause, failure) => {
  snapshot.mockResolvedValue(complete(5));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 3);
  await flush();
  socket.frame('reset_required', { seq: 50 }, 50);
  await flush();
  socket.frame('error', { code: 'specific_command_failure' }, 50);
  await flush();
  expect(state?.error).toContain('incomplete');
  expect(state?.error).toContain('specific_command_failure');
  snapshot.mockRejectedValueOnce(failure());
  socket.frame('reset_required', { seq: 60 }, 60);
  await flush();
  expect(state?.connection).toBe('disconnected');
  expect(state?.error).toContain(cause);
  expect(state?.error).toContain('incomplete');
  connection.close();
});

test('session moves wait for a revision-pinned authoritative canonical message instead of inventing its previous location', async () => {
  const initial: NativeSnapshot = {
    position: 1,
    revision: 1,
    entities: [],
    messages: [],
    session: { id: 'ses_a', origin: { directory: '/before' }, time: { created: 1, updated: 1 } },
  };
  snapshot.mockResolvedValueOnce(initial).mockResolvedValueOnce(initial);
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello(), 1);
  await flush();
  connectedSocket().frame(
    'session.moved',
    {
      syncPosition: 1,
      data: {
        data: {
          sessionID: 'ses_a',
          location: { directory: '/after', workspaceID: 'workspace-new' },
          projectID: 'project-new',
        },
      },
    },
    2,
    'events'
  );
  await flush();
  expect(state?.messages).toEqual([]);
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_2']);
  if (!state) throw new Error('Missing native state');
  expect(readNativeConversation(state).error).toContain('incomplete');
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(state.pendingSnapshotMessageIDs).toEqual(['msg_2']);
  const moved = {
    id: 'msg_2',
    type: 'location-switched',
    time: { created: 2 },
    location: { directory: '/after', workspaceID: 'workspace-new' },
    previous: {
      location: { directory: '/before', workspaceID: 'workspace-old' },
      projectID: 'project-old',
      metadata: { exact: 'native-only' },
    },
    projectID: 'project-new',
  };
  snapshot.mockResolvedValueOnce({
    ...initial,
    position: 2,
    revision: 2,
    session: { id: 'ses_a', time: { created: 1, updated: 2 }, origin: { directory: '/after' } },
    messages: [{ message: moved, seq: 2 }],
  });
  await jest.advanceTimersByTimeAsync(500);
  await flush();
  expect(state.pendingSnapshotMessageIDs).toEqual([]);
  expect(state.messages[0]?.message).toBe(moved);
  const conversation = readNativeConversation(state);
  expect(conversation.nativeMessages[0]?.message['previous']).toEqual(moved.previous);
  expect(conversation.incompleteMessageIDs).toEqual([]);
  expect(conversation.error).toBeUndefined();
  // The existing Cloud projector deliberately does not render location notices.
  expect(conversation.messages).toEqual([]);
  connection.close();
});

test.each(['session.tool.called', 'session.tool.success'])(
  'retains the triggering %s and refuses unchanged or unrelated snapshots as recovery proof',
  async type => {
    const initial: NativeSnapshot = {
      position: 1,
      revision: 1,
      session: sessionMetadata,
      entities: [],
      messages: [
        {
          seq: 1,
          message: { id: 'msg_gap', type: 'assistant', time: { created: 1 }, content: [] },
        },
      ],
    };
    snapshot.mockResolvedValueOnce(initial).mockResolvedValue(initial);
    const { client } = fixture();
    let state: NativeSessionState | undefined;
    const connection = client.connectSession('ses_a', value => {
      state = value;
    });
    await flush();
    const socket = connectedSocket();
    socket.frame('hello', hello(), 1);
    await flush();
    socket.frame(
      type,
      {
        syncPosition: 2,
        data: {
          data: {
            assistantMessageID: 'msg_gap',
            id: 'call',
            executed: true,
            input: { command: 'pwd' },
            content: [{ type: 'text', text: '/owned' }],
            metadata: { terminal: true },
          },
        },
      },
      2,
      'events'
    );
    await flush();
    expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_gap']);
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    expect(state?.messages[0]?.incomplete).toBe(true);
    expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_gap']);
    snapshot.mockResolvedValueOnce({ ...initial, position: 2, revision: 2 });
    await jest.advanceTimersByTimeAsync(500);
    await flush();
    expect(state?.messages[0]?.incomplete).toBe(true);
    expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_gap']);
    const authoritative: NativeSnapshot = {
      ...initial,
      position: 3,
      revision: 3,
      messages: [
        {
          seq: 1,
          message: {
            id: 'msg_gap',
            type: 'assistant',
            time: { created: 1 },
            content: [
              {
                type: 'tool',
                id: 'call',
                name: 'shell',
                time: {
                  created: 1,
                  ran: 2,
                  ...(type === 'session.tool.success' ? { completed: 2 } : {}),
                },
                state:
                  type === 'session.tool.success'
                    ? {
                        status: 'completed',
                        input: { command: 'pwd' },
                        content: [{ type: 'text', text: '/owned' }],
                        metadata: { terminal: true },
                      }
                    : { status: 'running', input: { command: 'pwd' }, metadata: {} },
              },
            ],
          },
        },
      ],
    };
    snapshot.mockResolvedValueOnce(authoritative);
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(state?.pendingSnapshotMessageIDs).toEqual([]);
    expect(state?.messages[0]?.incomplete).toBeUndefined();
    expect(state?.messages[0]?.message.content?.[0]?.state?.status).toBe(
      type === 'session.tool.success' ? 'completed' : 'running'
    );
    expect(state?.error).toBeUndefined();
    connection.close();
  }
);

test('missing initial session metadata recovers while retaining live messages instead of requiring a reopen', async () => {
  snapshot
    .mockResolvedValueOnce({ position: 0, revision: 0, entities: [], messages: [] })
    .mockResolvedValueOnce({
      position: 1,
      revision: 1,
      session: sessionMetadata,
      entities: [],
      messages: [],
    });
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 0);
  await flush();
  expect(state?.session).toBeUndefined();
  socket.frame(
    'remote.state',
    { incarnation: 'owned', runID: 'run', pending: { permissions: [], questions: [] } },
    1,
    'events'
  );
  socket.frame(
    'session.step.started',
    { syncPosition: 2, data: { data: { assistantMessageID: 'msg_live' } } },
    2,
    'events'
  );
  socket.frame(
    'session.text.delta',
    {
      syncPosition: 2,
      data: {
        data: {
          assistantMessageID: 'msg_live',
          ordinal: 0,
          delta: 'Visible after metadata arrives',
        },
      },
    },
    3,
    'events'
  );
  await flush();
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(state?.session).toEqual(sessionMetadata);
  if (!state) throw new Error('Missing recovered state');
  expect(readNativeConversation(state).messages[0]?.parts[0]).toMatchObject({
    type: 'text',
    text: 'Visible after metadata arrives',
  });
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(state.error).toBeUndefined();
  connection.close();
});

test('missing metadata recovery stops at its bound with a visible error, not a complete empty transcript', async () => {
  snapshot.mockResolvedValue({ position: 0, revision: 0, entities: [], messages: [] });
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello());
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(snapshot).toHaveBeenCalledTimes(5);
  expect(state?.session).toBeUndefined();
  expect(state?.error).toContain('incomplete');
  if (!state) throw new Error('Missing native state');
  expect(readNativeConversation(state).error).toContain('incomplete');
  expect(readNativeConversation(state).loading).toBe(false);
  connection.close();
});

test('binary snapshot assets share organization grants, renew a 401, and preserve cancellation', async () => {
  const { client, fetcher, calls } = fixture();
  const ordinary = fetcher.getMockImplementation();
  if (!ordinary) throw new Error('Missing fetch fixture');
  const authorizations: (string | null)[] = [];
  let assetCalls = 0;
  const controller = new AbortController();
  fetcher.mockImplementation(async (input, init) => {
    if (!new URL(String(input)).pathname.endsWith('/blobs/owned')) return ordinary(input, init);
    authorizations.push(new Headers(init?.headers).get('Authorization'));
    expect(init?.signal).toBe(controller.signal);
    assetCalls++;
    return assetCalls === 1
      ? Response.json({ error: { code: 'expired' } }, { status: 401 })
      : new Response(new Uint8Array([1, 2, 3]).buffer);
  });
  const expected: NativeSnapshot = {
    position: 1,
    revision: 1,
    session: sessionMetadata,
    messages: [],
    entities: [],
  };
  snapshot.mockImplementationOnce(async (_request, _sessionID, signal, readAsset) => {
    if (!readAsset) throw new Error('Missing authorized asset reader');
    const bytes = await readAsset('/v1/sessions/ses_a/blobs/owned', 3, { signal });
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    return expected;
  });
  await expect(client.getSnapshot('ses_a', 'organization-owned', controller.signal)).resolves.toBe(
    expected
  );
  expect(authorizations).toEqual(['Bearer grant', 'Bearer grant']);
  expect(calls.filter(call => call.path === '/v1/auth/exchange').map(call => call.body)).toEqual([
    { version: 1, organizationID: 'organization-owned' },
    { version: 1, organizationID: 'organization-owned' },
  ]);
  snapshot.mockImplementationOnce(async (_request, _sessionID, signal, readAsset) => {
    if (!readAsset) throw new Error('Missing authorized asset reader');
    await readAsset('/v1/sessions/ses_a/blobs/owned', 3, { signal });
    return expected;
  });
  controller.abort();
  await expect(
    client.getSnapshot('ses_a', 'organization-owned', controller.signal)
  ).rejects.toMatchObject({ code: 'request_canceled' });
  expect(assetCalls).toBe(2);
});

function assetSnapshotFixture(response: Response, advertisedBytes = 3) {
  const { client, fetcher } = fixture();
  const ordinary = fetcher.getMockImplementation();
  if (!ordinary) throw new Error('Missing fetch fixture');
  const hash = 'c'.repeat(64);
  const reference = `media:${hash}`;
  fetcher.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith(`/blobs/${hash}`)) return response;
    if (path === '/v1/sessions/ses_a') {
      return Response.json({
        version: 1,
        sessionID: 'ses_a',
        deleted: false,
        position: 1,
        revision: 1,
      });
    }
    if (path === '/v1/sessions/ses_a/entities') {
      return Response.json({
        version: 1,
        sessionID: 'ses_a',
        position: 1,
        revision: 1,
        next: null,
        entities: [
          { kind: 'session', id: 'ses_a', revision: 1, value: sessionMetadata },
          {
            kind: 'message',
            id: 'msg_asset',
            revision: 1,
            value: {
              seq: 0,
              message: {
                id: 'msg_asset',
                type: 'user',
                time: { created: 1 },
                text: 'inspect',
                files: [
                  {
                    mime: 'image/png',
                    name: 'image.png',
                    uri: reference,
                    source: { type: 'inline' },
                  },
                ],
              },
            },
          },
          {
            kind: 'asset',
            id: 'asset_owned',
            revision: 1,
            value: {
              entity: { kind: 'message', id: 'msg_asset' },
              pointer: '/message/files/0',
              reference,
              mime: 'image/png',
              blob: { hash, bytes: advertisedBytes },
            },
          },
        ],
      });
    }
    return ordinary(input, init);
  });
  snapshot.mockImplementationOnce(
    jest.requireActual<typeof NativeSnapshotModule>('./native-sync-snapshot').fetchNativeSnapshot
  );
  return client;
}

test.each([undefined, '3', '1'])(
  'cancels an overflowing native asset stream at the advertised byte bound with Content-Length %s',
  async length => {
    let pulls = 0;
    const cancel = jest.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(
            pulls < 3 ? new Uint8Array([pulls, pulls]) : new Uint8Array(1024 * 1024)
          );
          if (pulls === 3) controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const response = new Response(stream, {
      headers: length === undefined ? {} : { 'Content-Length': length },
    });
    const client = assetSnapshotFixture(response);
    await expect(client.getSnapshot('ses_a')).rejects.toMatchObject({
      code: 'blob_hash_mismatch',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBe(2);
    expect(stream.locked).toBe(false);
  }
);

test.each(['-1', 'invalid', '', '1.5', '9007199254740992'])(
  'rejects invalid native asset Content-Length %s before reading the body',
  async length => {
    const pull = jest.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    });
    const cancel = jest.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const client = assetSnapshotFixture(
      new Response(stream, { headers: { 'Content-Length': length } })
    );
    await expect(client.getSnapshot('ses_a')).rejects.toMatchObject({
      code: 'invalid_content_length',
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  }
);

test('rejects a native asset Content-Length above its authorized size before reading', async () => {
  const pull = jest.fn();
  const cancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const client = assetSnapshotFixture(new Response(stream, { headers: { 'Content-Length': '4' } }));
  await expect(client.getSnapshot('ses_a')).rejects.toMatchObject({
    code: 'blob_hash_mismatch',
  });
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
});

test('assembles fragmented native asset bytes into the authorized snapshot URL', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.enqueue(new Uint8Array([2, 3]));
      controller.close();
    },
  });
  const client = assetSnapshotFixture(new Response(stream));
  const result = await client.getSnapshot('ses_a');
  expect(Object.values(result.assetURLs ?? {})).toEqual(['data:image/png;base64,AQID']);
  expect(stream.locked).toBe(false);
});

test('rejects an asset stream that ends before the advertised byte count', async () => {
  const client = assetSnapshotFixture(new Response(new Uint8Array([1, 2])));
  await expect(client.getSnapshot('ses_a')).rejects.toMatchObject({
    code: 'blob_hash_mismatch',
  });
});

test('same-path live native tool files invalidate old bytes and resolve only through a newer authoritative snapshot', async () => {
  const uri = 'file:///owned/result.png';
  const key = kilo2AssetKey('msg_file_000000_file_0', uri, 'image/png');
  const result = [{ type: 'file', uri, mime: 'image/png' }];
  const initial: NativeSnapshot = {
    position: 1,
    revision: 1,
    session: sessionMetadata,
    entities: [],
    assetURLs: { [key]: 'data:image/png;base64,b2xk' },
    messages: [
      {
        seq: 1,
        message: {
          id: 'msg_file',
          type: 'assistant',
          time: { created: 1 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 1 },
              state: { status: 'completed', input: { path: '/owned/result.png' }, content: result },
            },
          ],
        },
      },
    ],
  };
  snapshot.mockResolvedValueOnce(initial);
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 1);
  await flush();
  socket.frame(
    'session.message.content.updated',
    {
      syncPosition: 2,
      data: {
        data: {
          messageID: 'msg_file',
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 2 },
              state: { status: 'completed', input: { path: '/owned/result.png' }, content: result },
            },
          ],
        },
      },
    },
    2,
    'events'
  );
  await flush();
  expect(state?.assetURLs?.[key]).toBeUndefined();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_file']);
  const authoritative: NativeSnapshot = {
    ...initial,
    position: 2,
    revision: 2,
    assetURLs: { [key]: 'data:image/png;base64,bmV3' },
    messages: [
      {
        seq: 1,
        message: {
          id: 'msg_file',
          type: 'assistant',
          time: { created: 1 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 2 },
              state: { status: 'completed', input: { path: '/owned/result.png' }, content: result },
            },
          ],
        },
      },
    ],
  };
  snapshot.mockResolvedValueOnce(authoritative);
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual([]);
  if (!state) throw new Error('Missing native file state');
  expect(readNativeConversation(state).messages[0]?.parts[1]).toMatchObject({
    type: 'file',
    url: 'data:image/png;base64,bmV3',
  });
  expect(state.error).toBeUndefined();
  connection.close();
});

test('a later missing terminal tool frame keeps its own frontier while an earlier tool call recovers', async () => {
  const initial: NativeSnapshot = {
    position: 1,
    revision: 1,
    session: sessionMetadata,
    entities: [],
    messages: [
      {
        seq: 1,
        message: { id: 'msg_frontier', type: 'assistant', time: { created: 1 }, content: [] },
      },
    ],
  };
  const running: NativeSnapshot = {
    ...initial,
    position: 2,
    revision: 2,
    messages: [
      {
        seq: 1,
        message: {
          id: 'msg_frontier',
          type: 'assistant',
          time: { created: 1 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'shell',
              time: { created: 1, ran: 2 },
              state: { status: 'running', input: { command: 'pwd' } },
            },
          ],
        },
      },
    ],
  };
  snapshot.mockResolvedValueOnce(initial).mockResolvedValueOnce(running);
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 1);
  await flush();
  socket.frame(
    'session.tool.called',
    {
      syncPosition: 2,
      data: {
        data: {
          assistantMessageID: 'msg_frontier',
          id: 'call',
          input: { command: 'pwd' },
          executed: true,
        },
      },
    },
    2,
    'events'
  );
  socket.frame(
    'session.tool.success',
    {
      syncPosition: 3,
      data: {
        data: {
          assistantMessageID: 'msg_frontier',
          id: 'call',
          content: [{ type: 'text', text: '/owned' }],
          executed: true,
        },
      },
    },
    3,
    'events'
  );
  await flush();
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_frontier']);
  expect(state?.messages[0]?.message.content?.[0]?.state?.status).toBe('completed');
  snapshot.mockResolvedValueOnce({ ...running, position: 3, revision: 3 });
  await jest.advanceTimersByTimeAsync(500);
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_frontier']);
  const terminal: NativeSnapshot = {
    ...running,
    position: 4,
    revision: 4,
    messages: [
      {
        seq: 1,
        message: {
          id: 'msg_frontier',
          type: 'assistant',
          time: { created: 1 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'shell',
              time: { created: 1, ran: 2, completed: 3 },
              state: {
                status: 'completed',
                input: { command: 'pwd' },
                content: [{ type: 'text', text: '/owned' }],
              },
            },
          ],
        },
      },
    ],
  };
  snapshot.mockResolvedValueOnce(terminal);
  await jest.advanceTimersByTimeAsync(1000);
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual([]);
  expect(state?.error).toBeUndefined();
  connection.close();
});
