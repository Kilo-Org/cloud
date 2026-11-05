import {
  NativeSyncClient,
  NativeSyncError,
  applyNativeEvent,
  type NativeSocket,
  type NativeSessionState,
  type NativePresenceState,
} from './native-sync';
import { fetchNativeSnapshot, type NativeSnapshot } from './native-sync-snapshot';

jest.mock('./native-sync-snapshot', () => ({ fetchNativeSnapshot: jest.fn() }));
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
beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.sockets = [];
  snapshot.mockResolvedValue({ position: 0, revision: 1, entities: [], messages: [] });
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
    { syncPosition: 1, data: { data: { assistantMessageID: 'm1' } } },
    12,
    'events'
  );
  socket.frame(
    'session.text.delta',
    { syncPosition: 2, data: { data: { assistantMessageID: 'm1', ordinal: 0, delta: 'hello' } } },
    15,
    'events'
  );
  socket.frame(
    'session.text.delta',
    {
      syncPosition: 2,
      data: { data: { assistantMessageID: 'm1', ordinal: 0, delta: 'duplicate' } },
    },
    15,
    'events'
  );
  await flush();
  expect(state?.messages[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
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
    revision: 4,
    entities: [],
    messages: [{ id: 'durable', role: 'user', content: 'restored', seq: 1 }],
  });
  socket.frame('reset_required', { seq: 40 }, 40);
  await flush();
  expect(state?.messages[0]?.content).toBe('restored');
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
    { incarnation: 'runner-1', runID: 'run-2', data: {} },
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
    { syncPosition: 1, data: { data: { assistantMessageID: 'old' } } },
    1,
    'events'
  );
  await flush();
  await connection.sendCommand('/clear');
  expect(state?.messages).toEqual([]);
  expect(calls.filter(call => call.path.endsWith('/commands'))).toEqual([]);
  socket.frame(
    'session.step.started',
    { syncPosition: 2, data: { data: { assistantMessageID: 'new' } } },
    2,
    'events'
  );
  await flush();
  expect(state?.messages.map(message => message.id)).toEqual(['new']);
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
    revision: 1,
    entities: [],
    messages: [{ id: 'm', role: 'assistant', content: [], seq: 1, incomplete: true }],
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
    { syncPosition: 10, data: { data: { assistantMessageID: 'm', ordinal: 2, delta: 'live' } } },
    1,
    'events'
  );
  await flush();
  expect(state?.messages[0]?.content).toEqual([{ type: 'text', text: 'live' }]);
  expect(state?.messages[0]?.incomplete).toBe(true);
  snapshot.mockResolvedValueOnce({
    position: 20,
    revision: 2,
    entities: [],
    messages: [
      {
        id: 'm',
        role: 'assistant',
        content: [{ type: 'text', text: 'full live' }],
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
  expect(state?.messages[0]?.content).toEqual([{ type: 'text', text: 'full live' }]);
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

test('native inbox payloads and sparse part ordinals project correctly', () => {
  const frame = (type: string, data: unknown) => ({
    v: 1 as const,
    channel: 'events' as const,
    seq: 2,
    type,
    from: 'runner',
    at: 1,
    body: { data: { data } },
  });
  const user = applyNativeEvent(
    [],
    frame('session.inbox.enqueued', {
      inboxID: 'user',
      item: { type: 'user', payload: { text: 'prompt' } },
    })
  );
  expect(user[0]?.content).toBe('prompt');
  const messages = [
    {
      id: 'm',
      role: 'assistant',
      seq: 1,
      content: [
        { type: 'text', text: 'two' },
        { type: 'text', text: 'ten' },
      ],
      partOrdinals: [2, 10],
    },
  ];
  expect(
    applyNativeEvent(
      messages,
      frame('session.text.delta', { assistantMessageID: 'm', ordinal: 10, delta: '!' })
    )[0]?.content
  ).toEqual([
    { type: 'text', text: 'two' },
    { type: 'text', text: 'ten!' },
  ]);
  const replaced = applyNativeEvent(
    messages,
    frame('session.message.content.updated', {
      messageID: 'm',
      content: [{ type: 'text', text: 'replacement' }],
    })
  );
  expect(replaced[0]?.content).toEqual([{ type: 'text', text: 'replacement' }]);
  expect(replaced[0]?.partOrdinals).toBeUndefined();
  expect(
    applyNativeEvent(
      replaced,
      frame('session.text.delta', { assistantMessageID: 'm', ordinal: 0, delta: '!' })
    )[0]?.content
  ).toEqual([{ type: 'text', text: 'replacement!' }]);
});

const incomplete = (position: number) => ({
  position,
  revision: 1,
  entities: [],
  messages: [{ id: 'm', role: 'assistant', content: [], seq: 1, incomplete: true }],
});
const complete = (position: number) => ({
  position,
  revision: 2,
  entities: [],
  messages: [{ id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }], seq: 1 }],
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
      { syncPosition, data: { data: { assistantMessageID: 'm', ordinal: 0, delta: text } } },
      seq,
      'events'
    );
  delta(4, 5, 'live');
  await flush();
  expect(state?.messages[0]?.content).toEqual([{ type: 'text', text: 'live' }]);
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
  expect(state?.messages[0]?.content).toEqual([{ type: 'text', text: 'done more' }]);
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
