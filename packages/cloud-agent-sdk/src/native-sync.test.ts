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
import { NATIVE_SYNC_REQUEST_DEADLINE_MS, NATIVE_SYNC_TICKET_MINT_DEADLINE_MS } from './limits';
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
/** Drains enough microtask hops to reach the socket: the mint crosses the bounded credential lookup. */
async function flush() {
  for (let index = 0; index < 60; index++) await Promise.resolve();
}
/** Records how a promise settles without leaving its rejection unhandled. */
function trackOutcome(operation: Promise<unknown>) {
  const state = { code: 'pending' };
  void operation.then(
    () => {
      state.code = 'resolved';
    },
    (error: { code?: string }) => {
      state.code = error.code ?? 'failed';
    }
  );
  return state;
}
function fixture(respond?: (path: string) => Promise<Response> | undefined) {
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
    const overridden = await respond?.(path);
    if (overridden) return overridden;
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

/** A fetcher whose `reauth_required` ticket mint can be held open, to observe work beside it. */
function heldTicketFixture() {
  const calls: { path: string }[] = [];
  let held: ((value: Response) => void) | undefined;
  let stall = false;
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path });
    if (path.endsWith('/exchange'))
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    if (path.endsWith('live-ticket')) {
      if (!stall)
        return Response.json({
          ticket: 'private-ticket',
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
        });
      // ES2022/Hermes consumers do not provide Promise.withResolvers.
      return new Promise<Response>(resolve => {
        held = resolve;
      });
    }
    return Response.json({ status: 'queued' });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  return {
    client,
    stall: () => {
      stall = true;
    },
    resume: () => {
      stall = false;
    },
    release: (ticket: string) =>
      held?.(Response.json({ ticket, expiresAt: new Date(Date.now() + 90_000).toISOString() })),
    ticketPosts: () => calls.filter(call => call.path.endsWith('/live-ticket')).length,
  };
}

test('a stalled reauth mint keeps draining the queue and reconnects at its deadline', async () => {
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  const { client, stall, resume, ticketPosts } = heldTicketFixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  try {
    await flush();
    const socket = connectedSocket();
    socket.frame('hello', hello(), 3);
    await flush();
    expect(ticketPosts()).toBe(1);
    stall();
    socket.frame('reauth_required', {}, 4);
    socket.frame(
      'session.status',
      { syncPosition: 2, data: { data: { status: 'running' } } },
      5,
      'events'
    );
    await flush();
    // The queued frame is projected while the mint is still outstanding.
    expect(state?.events.some(event => event['seq'] === 5)).toBe(true);
    expect(ticketPosts()).toBe(2);
    expect(socket.sent.filter(value => value['type'] === 'reauth')).toEqual([]);
    // The deadline retires the epoch instead of holding the queue until the mint settles.
    await jest.advanceTimersByTimeAsync(NATIVE_SYNC_TICKET_MINT_DEADLINE_MS);
    await flush();
    expect(state?.connection).toBe('disconnected');
    resume();
    await jest.advanceTimersByTimeAsync(2000);
    await flush();
    expect(FakeSocket.sockets).toHaveLength(2);
  } finally {
    random.mockRestore();
    connection.close();
  }
});

test('coalesces reauth_required frames onto one in-flight ticket mint', async () => {
  const { client, stall, release, ticketPosts } = heldTicketFixture();
  const connection = client.connectSession('ses_a', () => {});
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 3);
  await flush();
  stall();
  socket.frame('reauth_required', {}, 4);
  socket.frame('reauth_required', {}, 5);
  await flush();
  expect(ticketPosts()).toBe(2);
  expect(socket.sent.filter(value => value['type'] === 'reauth')).toEqual([]);
  release('second-ticket');
  await flush();
  expect(ticketPosts()).toBe(2);
  expect(socket.sent.filter(value => value['type'] === 'reauth')).toEqual([
    { type: 'reauth', ticket: 'second-ticket' },
  ]);
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

test('keeps the newest command status when a frame advances it before the POST answer settles', async () => {
  let answer: (response: Response) => void = () => {
    throw new Error('command POST answer was not requested');
  };
  const pending = new Promise<Response>(resolve => {
    answer = resolve;
  });
  const { client, calls } = fixture(path => (path.endsWith('/commands') ? pending : undefined));
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  await flush();
  const sent = connection.sendMessage('queue me', { queueIfOffline: true });
  await flush();
  const posted = calls.find(call => call.path.endsWith('/commands'))?.body.commandID;
  expect(typeof posted).toBe('string');
  const commandID = posted as string;
  socket.frame('command_status', { commandID, status: 'delivered' });
  await flush();
  expect(state?.commands[commandID]).toBe('delivered');
  answer(Response.json({ commandID, status: 'queued' }));
  await sent;
  await flush();
  expect(state?.commands[commandID]).toBe('delivered');
  connection.close();
});

test('a late status poll answer does not regress a frame-reported expiry', async () => {
  let answer: (response: Response) => void = () => {
    throw new Error('status poll answer was not requested');
  };
  const pending = new Promise<Response>(resolve => {
    answer = resolve;
  });
  const { client } = fixture(path =>
    path.endsWith('/commands/cmd_expired') ? pending : undefined
  );
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello());
  await flush();
  socket.frame('command_status', { commandID: 'cmd_expired', status: 'expired' });
  await flush();
  expect(state?.commands['cmd_expired']).toBe('expired');
  const status = connection.getCommandStatus('cmd_expired');
  await flush();
  answer(Response.json({ commandID: 'cmd_expired', status: 'queued' }));
  await expect(status).resolves.toBe('expired');
  expect(state?.commands['cmd_expired']).toBe('expired');
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
  expect(state?.pending).toEqual({
    permissions: [],
    questions: [],
    unreadableQuestions: [],
    unreadablePermissions: [],
  });
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

test('a mixed pending inventory publishes readable cards and an unreadable notice together', async () => {
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
        permissions: [
          { requestID: 'readable', tool: 'edit', summary: 'file' },
          { requestID: 'unreadable', tool: 'edit', summary: 7 },
        ],
        questions: [
          { requestID: 'question', fields: [{ type: 'string', key: 'q', title: 'Which?' }] },
        ],
      },
    },
    1,
    'events'
  );
  await flush();
  expect(state?.pending.permissions.map(item => item.id)).toEqual(['readable']);
  expect(state?.pending.unreadablePermissions).toEqual([{ requestId: 'unreadable' }]);
  expect(state?.pending.questions.map(item => item.id)).toEqual(['question']);
  expect(state?.connection).toBe('connected');
  connection.close();
});

test('an unreadable live permission is published by identity until the runner replies', async () => {
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
    'permission.asked',
    { incarnation: 'runner', runID: 'run', data: { data: { id: 'perm-unreadable' } } },
    1,
    'events'
  );
  await flush();
  expect(state?.pending.permissions).toEqual([]);
  expect(state?.pending.unreadablePermissions).toEqual([{ requestId: 'perm-unreadable' }]);
  socket.frame(
    'permission.replied',
    { incarnation: 'runner', runID: 'run', data: { data: { requestID: 'perm-unreadable' } } },
    2,
    'events'
  );
  await flush();
  expect(state?.pending.unreadablePermissions).toEqual([]);
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

test('three failed snapshot cycles settle the transport until an explicit refresh', async () => {
  snapshot.mockRejectedValue(new Error('Native state read failed'));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const cycle = async (index: number) => {
    connectedSocket(index).frame('hello', hello());
    await flush();
    await jest.advanceTimersByTimeAsync(2001);
    await flush();
  };
  await cycle(0);
  await cycle(1);
  await cycle(2);
  expect(state?.connection).toBe('disconnected');
  expect(state?.snapshotFailure?.error).toContain('Native state read failed');
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(FakeSocket.sockets).toHaveLength(3);
  for (const socket of FakeSocket.sockets.slice(3)) socket.frame('hello', hello());
  await jest.advanceTimersByTimeAsync(120_000);
  await flush();
  expect(FakeSocket.sockets).toHaveLength(3);
  expect(snapshot).toHaveBeenCalledTimes(3);
  connection.close();
});

test('a successful snapshot cycle resets the failure streak', async () => {
  const failure = () => new Error('Native state read failed');
  snapshot
    .mockRejectedValueOnce(failure())
    .mockRejectedValueOnce(failure())
    .mockResolvedValueOnce({
      position: 0,
      revision: 1,
      session: sessionMetadata,
      entities: [],
      messages: [],
    })
    .mockRejectedValue(failure());
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  for (const index of [0, 1]) {
    connectedSocket(index).frame('hello', hello());
    await flush();
    await jest.advanceTimersByTimeAsync(2001);
    await flush();
  }
  connectedSocket(2).frame('hello', hello(), 20);
  await flush();
  expect(state?.snapshotFailure).toBeUndefined();
  connectedSocket(2).frame('reset_required', { seq: 21 }, 21);
  await flush();
  expect(state?.snapshotFailure).toBeUndefined();
  await jest.advanceTimersByTimeAsync(2001);
  await flush();
  connectedSocket(3).frame('reset_required', { seq: 22 }, 22);
  await flush();
  expect(state?.connection).toBe('disconnected');
  expect(state?.snapshotFailure).toBeUndefined();
  await jest.advanceTimersByTimeAsync(2001);
  await flush();
  connectedSocket(4).frame('reset_required', { seq: 23 }, 23);
  await flush();
  expect(state?.connection).toBe('disconnected');
  expect(state?.snapshotFailure?.error).toContain('Native state read failed');
  expect(snapshot).toHaveBeenCalledTimes(6);
  connection.close();
});

test('refresh after a latch clears the marker and reads a fresh snapshot', async () => {
  snapshot.mockRejectedValue(new Error('Native state read failed'));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const cycle = async (index: number) => {
    connectedSocket(index).frame('hello', hello());
    await flush();
    await jest.advanceTimersByTimeAsync(2001);
    await flush();
  };
  await cycle(0);
  await cycle(1);
  await cycle(2);
  expect(state?.snapshotFailure?.error).toContain('Native state read failed');
  expect(FakeSocket.sockets).toHaveLength(3);
  snapshot.mockResolvedValueOnce({
    position: 4,
    revision: 2,
    session: sessionMetadata,
    entities: [],
    messages: [],
  });
  connection.refresh();
  await flush();
  expect(state?.snapshotFailure).toBeUndefined();
  expect(FakeSocket.sockets).toHaveLength(4);
  connectedSocket(3).frame('hello', hello(), 7);
  await flush();
  expect(connectedSocket(3).sent).toContainEqual({ type: 'subscribe', afterSeq: 7 });
  expect(state?.snapshot?.position).toBe(4);
  expect(state?.connection).toBe('connected');
  expect(snapshot).toHaveBeenCalledTimes(4);
  connection.close();
});

test('refresh after a reset-cycle latch re-reads the transcript at its new position', async () => {
  snapshot.mockResolvedValueOnce(complete(5));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket(0).frame('hello', hello(), 3);
  await flush();
  expect(state?.snapshot?.position).toBe(5);
  snapshot.mockRejectedValue(new Error('Native state read failed'));
  for (const index of [0, 1, 2]) {
    connectedSocket(index).frame('reset_required', { seq: 20 + index }, 20 + index);
    await flush();
    await jest.advanceTimersByTimeAsync(2001);
    await flush();
  }
  expect(state?.snapshotFailure?.error).toContain('Native state read failed');
  expect(FakeSocket.sockets).toHaveLength(3);
  // The reset transcript restarts behind the position read before it.
  snapshot.mockResolvedValueOnce({ ...complete(4), revision: 3 });
  connection.refresh();
  await flush();
  expect(state?.snapshotFailure).toBeUndefined();
  expect(state?.error).toBeUndefined();
  connectedSocket(3).frame('hello', hello(), 6);
  await flush();
  expect(state?.snapshot?.position).toBe(4);
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'done' }]);
  expect(state?.error).toBeUndefined();
  expect(connectedSocket(3).sent).toContainEqual({ type: 'subscribe', afterSeq: 6 });
  expect(snapshot).toHaveBeenCalledTimes(5);
  connection.close();
});

test('refresh keeps a warning for a frame no later snapshot has covered yet', async () => {
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
  socket.frame(
    'session.step.started',
    { syncPosition: 9, data: { data: { id: 'invalid' } } },
    4,
    'events'
  );
  await flush();
  expect(state?.error).toContain('skipped an event it could not read');
  // Three exhausted recoveries latch while the unprojectable frame stays uncovered.
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  socket.frame('reset_required', { seq: 5 }, 5);
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  socket.frame('reset_required', { seq: 6 }, 6);
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.snapshotFailure?.error).toContain('recovery is incomplete');
  // The refreshed read still does not cover the quarantined frame.
  snapshot.mockResolvedValue(complete(5));
  connection.refresh();
  await flush();
  expect(state?.snapshotFailure).toBeUndefined();
  connectedSocket(1).frame('hello', hello(), 7);
  await flush();
  expect(state?.error).toContain('skipped an event it could not read');
  connection.close();
});

test('refresh clears a replay-loss notice only with an authoritative read', async () => {
  snapshot.mockResolvedValueOnce(complete(5));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket(0).frame('hello', hello(), 3);
  await flush();
  expect(state?.error).toBeUndefined();
  // Replay was unavailable, so the transcript cannot be certified from the live stream.
  snapshot.mockRejectedValue(new Error('Native state read failed'));
  connectedSocket(0).frame('reset_required', { seq: 9 }, 9);
  await flush();
  expect(state?.error).toContain('may be incomplete');
  // A clean subscribe alone does not certify it.
  connectedSocket(0).frame('subscribed', { seq: 9 }, 9);
  await flush();
  expect(state?.error).toContain('may be incomplete');
  // The authoritative read does, and the notice goes with it.
  snapshot.mockResolvedValueOnce({ ...complete(9), revision: 2 });
  connection.refresh();
  await flush();
  connectedSocket(1).frame('hello', hello(), 12);
  await flush();
  connectedSocket(1).frame('subscribed', { seq: 12 }, 12);
  await flush();
  expect(state?.error).toBeUndefined();
  expect(state?.snapshot?.position).toBe(9);
  connection.close();
});

test('a retry that cannot read the transcript reports the terminal failure', async () => {
  snapshot.mockResolvedValueOnce(complete(5));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket(0).frame('hello', hello(), 3);
  await flush();
  snapshot.mockRejectedValue(new Error('Native state read failed'));
  connectedSocket(0).frame('reset_required', { seq: 9 }, 9);
  await flush();
  expect(state?.error).toContain('may be incomplete');
  connection.refresh();
  await flush();
  for (const index of [1, 2, 3]) {
    connectedSocket(index).frame('hello', hello());
    await flush();
    await jest.advanceTimersByTimeAsync(2001);
    await flush();
  }
  expect(state?.connection).toBe('disconnected');
  expect(state?.snapshotFailure?.error).toContain('Native state read failed');
  expect(state?.error).toBe(state?.snapshotFailure?.error);
  connection.close();
});

test('a read canceled by a closing socket never counts toward the bound', async () => {
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  for (const index of [0, 1, 2, 3]) {
    snapshot.mockImplementationOnce(
      (_request, _sessionID, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new NativeSyncError('request_canceled')));
        })
    );
    const socket = connectedSocket(index);
    socket.frame('hello', hello());
    await flush();
    socket.close();
    await flush();
    await jest.advanceTimersByTimeAsync(2001);
    await flush();
    expect(state?.snapshotFailure).toBeUndefined();
  }
  expect(FakeSocket.sockets.length).toBeGreaterThan(3);
  connection.close();
});

test('a retry keeps a more specific transcript notice', async () => {
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
  socket.frame(
    'session.step.started',
    { syncPosition: 9, data: { data: { id: 'invalid' } } },
    4,
    'events'
  );
  await flush();
  expect(state?.error).toContain('skipped an event it could not read');
  // Replay is unavailable as well, and its notice names the loss the client cannot repair.
  snapshot.mockRejectedValueOnce(new Error('Native state read failed'));
  socket.frame('reset_required', { seq: 9 }, 9);
  await flush();
  expect(state?.error).toContain('may be incomplete');
  connection.refresh();
  await flush();
  expect(state?.error).toContain('may be incomplete');
  expect(state?.error).not.toContain('skipped an event it could not read');
  connection.close();
});

test('a retry during a recovery still settles the transcript', async () => {
  snapshot.mockResolvedValueOnce(incomplete(5));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket(0).frame('hello', hello(), 3);
  await flush();
  // A live frame is retained for replay while recovery waits out its backoff.
  await jest.advanceTimersByTimeAsync(250);
  connectedSocket(0).frame(
    'session.text.delta',
    { syncPosition: 6, data: { data: { assistantMessageID: 'msg_m', ordinal: 0, delta: 'live' } } },
    4,
    'events'
  );
  await flush();
  snapshot.mockResolvedValueOnce(complete(6));
  connection.refresh();
  await flush();
  connectedSocket(1).frame('hello', hello(), 8);
  await flush();
  connectedSocket(1).frame('subscribed', { seq: 8 }, 8);
  await flush();
  expect(state?.error).toBeUndefined();
  expect(state?.messages[0]?.message.incomplete).toBeUndefined();
  expect(state?.connection).toBe('connected');
  connection.close();
});

test('an unreadable native asset latches on the first snapshot read', async () => {
  snapshot.mockRejectedValueOnce(
    Object.assign(new Error('asset file is not readable'), { code: 'native_asset_not_found' })
  );
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello());
  await flush();
  expect(state?.connection).toBe('disconnected');
  expect(state?.snapshotFailure?.error).toBe(
    'Native transcript is unavailable: asset file is not readable. Open the session again to retry.'
  );
  expect(snapshot).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(120_000);
  await flush();
  expect(FakeSocket.sockets).toHaveLength(1);
  expect(snapshot).toHaveBeenCalledTimes(1);
  connection.close();
});

test('a missing session stays retryable past the snapshot failure limit', async () => {
  snapshot.mockRejectedValue(new NativeSyncError('session_not_found', 404));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  for (let index = 0; index < 5; index++) {
    connectedSocket(index).frame('hello', hello());
    await flush();
    expect(state?.snapshotFailure).toBeUndefined();
    expect(FakeSocket.sockets).toHaveLength(index + 1);
    await jest.advanceTimersByTimeAsync(2001);
    await flush();
  }
  expect(FakeSocket.sockets).toHaveLength(6);
  expect(snapshot).toHaveBeenCalledTimes(5);
  connection.close();
});

test('exhausted recovery reads count one failed cycle each', async () => {
  snapshot
    .mockResolvedValueOnce(incomplete(5))
    .mockRejectedValue(new Error('Native state read failed'));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 3);
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.error).toContain('Native transcript recovery is incomplete');
  expect(state?.snapshotFailure).toBeUndefined();
  socket.frame('session.execution.succeeded', { syncPosition: 6, data: { data: {} } }, 4, 'events');
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.snapshotFailure).toBeUndefined();
  socket.frame('session.execution.succeeded', { syncPosition: 7, data: { data: {} } }, 5, 'events');
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.connection).toBe('disconnected');
  expect(state?.snapshotFailure?.error).toContain('Native state read failed');
  expect(snapshot).toHaveBeenCalledTimes(13);
  expect(FakeSocket.sockets).toHaveLength(1);
  connection.close();
});

test('an unconverged recovery snapshot counts one failed cycle each', async () => {
  snapshot.mockResolvedValue(incomplete(5));
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 3);
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.error).toContain('Native transcript recovery is incomplete.');
  expect(state?.snapshotFailure).toBeUndefined();
  socket.frame('session.execution.succeeded', { syncPosition: 6, data: { data: {} } }, 4, 'events');
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.snapshotFailure).toBeUndefined();
  socket.frame('session.execution.succeeded', { syncPosition: 7, data: { data: {} } }, 5, 'events');
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.connection).toBe('disconnected');
  expect(state?.snapshotFailure?.error).toBe(
    'Native transcript is unavailable: Native transcript recovery is incomplete. Open the session again to retry.'
  );
  expect(snapshot).toHaveBeenCalledTimes(13);
  expect(FakeSocket.sockets).toHaveLength(1);
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

function flakyTicketFixture(failingTickets: number) {
  const calls: { path: string }[] = [];
  let tickets = 0;
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path });
    if (path.endsWith('/exchange'))
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    if (path.endsWith('ticket')) {
      tickets++;
      if (tickets <= failingTickets)
        return Response.json({ error: { code: 'service_overloaded' } }, { status: 503 });
      return Response.json({
        ticket: 'private-ticket',
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      });
    }
    return Response.json({ status: 'queued' });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  return { client, calls };
}

test('connect attempts that never reach hello escalate to the ceiling', async () => {
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  const { client, calls } = flakyTicketFixture(Number.POSITIVE_INFINITY);
  const connection = client.connectSession('ses_a', () => {});
  const attempts = () => calls.filter(call => call.path.endsWith('live-ticket')).length;
  try {
    await flush();
    expect(attempts()).toBe(1);
    const steps = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000];
    for (const [index, step] of steps.entries()) {
      await jest.advanceTimersByTimeAsync(step);
      await flush();
      expect(attempts()).toBe(index + 2);
    }
    expect(FakeSocket.sockets).toHaveLength(0);
  } finally {
    random.mockRestore();
    connection.close();
  }
});

test('hello resets the connect backoff', async () => {
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  const { client, calls } = flakyTicketFixture(2);
  const connection = client.connectSession('ses_a', () => {});
  const attempts = () => calls.filter(call => call.path.endsWith('live-ticket')).length;
  try {
    await flush();
    expect(attempts()).toBe(1);
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(attempts()).toBe(2);
    await jest.advanceTimersByTimeAsync(2000);
    await flush();
    expect(attempts()).toBe(3);
    expect(FakeSocket.sockets).toHaveLength(1);
    const socket = connectedSocket();
    socket.frame('hello', hello());
    await flush();
    socket.close();
    await flush();
    // The escalated step stood at 4000 ms; only a hello reset yields a retry after 1000 ms.
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(attempts()).toBe(4);
    expect(FakeSocket.sockets).toHaveLength(2);
  } finally {
    random.mockRestore();
    connection.close();
  }
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

test('an unprojectable live event quarantines and converges from a covering snapshot without reconnecting', async () => {
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
  socket.frame(
    'session.renamed',
    { syncPosition: 2, data: { data: { title: 'first' } } },
    4,
    'events'
  );
  await flush();
  expect(state?.session?.title).toBe('first');
  expect(state?.error).toBeUndefined();
  // Missing assistantMessageID: the reducer's schema parse throws, and the frame carries
  // no syncPosition, so projection runs and fails before the cursor advances.
  const poison = { data: { data: { id: 'invalid' } } };
  socket.frame('session.step.started', poison, 5, 'events');
  await flush();
  expect(FakeSocket.sockets).toHaveLength(1);
  expect(socket.readyState).toBe(1);
  expect(state?.connection).toBe('connected');
  expect(state?.error).toContain('skipped an event it could not read');
  expect(state?.messages).toHaveLength(1);
  const afterQuarantine = snapshot.mock.calls.length;
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(snapshot.mock.calls.length - afterQuarantine).toBe(1);
  expect(state?.error).toContain('skipped an event it could not read');
  snapshot.mockResolvedValueOnce({ ...complete(5), position: 6, revision: 3 });
  await jest.advanceTimersByTimeAsync(1000);
  await flush();
  expect(state?.error).toBeUndefined();
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'done' }]);
  socket.frame(
    'session.renamed',
    { syncPosition: 6, data: { data: { title: 'kept working' } } },
    6,
    'events'
  );
  await flush();
  expect(state?.session?.title).toBe('kept working');
  expect(state?.error).toBeUndefined();
  socket.frame('session.step.started', poison, 7, 'events');
  await flush();
  expect(FakeSocket.sockets).toHaveLength(1);
  expect(state?.connection).toBe('connected');
  expect(state?.error).toContain('skipped an event it could not read');
  const afterSecond = snapshot.mock.calls.length;
  await jest.advanceTimersByTimeAsync(800);
  await flush();
  expect(snapshot.mock.calls.length - afterSecond).toBe(2);
  expect(state?.error).toContain('skipped an event it could not read');
  snapshot.mockResolvedValueOnce({ ...complete(5), position: 8, revision: 4 });
  await jest.advanceTimersByTimeAsync(1500);
  await flush();
  expect(state?.error).toBeUndefined();
  expect(FakeSocket.sockets).toHaveLength(1);
  socket.frame('session.step.started', poison, 5, 'events');
  await flush();
  expect(FakeSocket.sockets).toHaveLength(1);
  expect(state?.error).toBeUndefined();
  expect(state?.session).toEqual(sessionMetadata);
  connection.close();
});

test('a quarantine clears once any snapshot read covers it, even after the recovery window closed', async () => {
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
  socket.frame('session.step.started', { data: { data: { id: 'invalid' } } }, 4, 'events');
  await flush();
  expect(state?.error).toContain('skipped an event it could not read');
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.error).toContain('recovery is incomplete');
  snapshot.mockResolvedValue({ ...complete(6), revision: 3 });
  socket.frame('session.execution.succeeded', { syncPosition: 6, data: { data: {} } }, 5, 'events');
  await flush();
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(state?.error).toBeUndefined();
  expect(state?.pendingSnapshotMessageIDs ?? []).toEqual([]);
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'done' }]);
  expect(FakeSocket.sockets).toHaveLength(1);
  connection.close();
});

test('a canonical snapshot publish prunes a quarantine instead of waiting for another recovery', async () => {
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
  socket.frame('session.step.started', { data: { data: { id: 'invalid' } } }, 4, 'events');
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  await flush();
  expect(state?.error).toContain('recovery is incomplete');
  const reads = snapshot.mock.calls.length;
  snapshot.mockResolvedValue({ ...complete(7), revision: 4 });
  socket.frame('reset_required', { seq: 6 }, 6);
  await flush();
  expect(snapshot.mock.calls.length).toBe(reads + 1);
  await jest.advanceTimersByTimeAsync(500);
  await flush();
  expect(snapshot.mock.calls.length).toBe(reads + 1);
  expect(state?.pendingSnapshotMessageIDs ?? []).toEqual([]);
  connection.close();
});

test('a throwing state listener is not treated as an unreadable frame', async () => {
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const observed: NativeSessionState[] = [];
  let thrown = false;
  const connection = client.connectSession('ses_a', value => {
    observed.push(value);
    state = value;
    const previous = observed[observed.length - 2];
    if (!thrown && previous && value.messages.length > previous.messages.length) {
      thrown = true;
      throw new Error('consumer failure');
    }
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 3);
  await flush();
  socket.frame(
    'session.step.started',
    { syncPosition: 1, data: { data: { assistantMessageID: 'msg_m1' } } },
    4,
    'events'
  );
  await flush();
  expect(thrown).toBe(true);
  expect(state?.error).toBe('consumer failure');
  expect(observed.some(value => value.error?.includes('skipped an event it could not read'))).toBe(
    false
  );
  await jest.advanceTimersByTimeAsync(2001);
  await flush();
  expect(FakeSocket.sockets).toHaveLength(2);
  connection.close();
});

test('a deterministically throwing state listener advances the cursor instead of replaying the frame', async () => {
  const { client } = fixture();
  let observed = 0;
  const connection = client.connectSession('ses_a', value => {
    const converted = value.events.length;
    if (value.connection === 'connected' && converted > observed) {
      observed = converted;
      throw new Error('consumer failure');
    }
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 3);
  await flush();
  socket.frame(
    'session.step.started',
    { syncPosition: 1, data: { data: { assistantMessageID: 'msg_m1' } } },
    4,
    'events'
  );
  await flush();
  await jest.advanceTimersByTimeAsync(2001);
  await flush();
  expect(FakeSocket.sockets).toHaveLength(2);
  connectedSocket(1).frame('hello', hello(), 5);
  await flush();
  expect(connectedSocket(1).sent).toContainEqual({ type: 'subscribe', afterSeq: 4 });
  connection.close();
});

test('per-frame gap detection stays first-match and additive for changed message references', async () => {
  const canonical: NativeSnapshot = {
    position: 5,
    revision: 2,
    session: sessionMetadata,
    entities: [],
    messages: [
      {
        message: {
          id: 'msg_first',
          type: 'assistant',
          time: { created: 1 },
          content: [{ type: 'text', text: 'one' }],
        },
        seq: 1,
      },
      {
        message: {
          id: 'msg_second',
          type: 'assistant',
          time: { created: 1 },
          content: [{ type: 'text', text: 'two' }],
        },
        seq: 2,
      },
    ],
  };
  snapshot.mockResolvedValue(canonical);
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 3);
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toBeUndefined();
  // (a) An ordinal far past the stored content marks the receiving message incomplete, so
  // the exact expected gap set here is ["msg_first"].
  socket.frame(
    'session.text.delta',
    { data: { data: { assistantMessageID: 'msg_first', ordinal: 5, delta: 'gap' } } },
    4,
    'events'
  );
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_first']);
  // The wrapper item keeps the stored content, with no incomplete marker: the gap list
  // alone drives the pending id set.
  expect(state?.messages[0]?.message).toBe(canonical.messages[0]?.message);
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'one' }]);
  // (a) The healing ordinal-zero delta still does not clear the pending id: only a
  // canonical snapshot read can.
  const firstMessage = state?.messages[0]?.message;
  expect(firstMessage).toBeDefined();
  socket.frame(
    'session.text.delta',
    { data: { data: { assistantMessageID: 'msg_first', ordinal: 0, delta: ' live' } } },
    5,
    'events'
  );
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_first']);
  expect(state?.messages[0]?.message.content).toEqual([{ type: 'text', text: 'one live' }]);
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  // The covering canonical read restores the stored part and clears the gap.
  snapshot.mockResolvedValueOnce({
    ...canonical,
    position: 9,
    revision: 3,
    messages: [
      {
        message: {
          id: 'msg_first',
          type: 'assistant',
          time: { created: 1, completed: 6 },
          content: [{ type: 'text', text: 'one' }],
        },
        seq: 1,
      },
      {
        message: {
          id: 'msg_second',
          type: 'assistant',
          time: { created: 1 },
          content: [{ type: 'text', text: 'two' }],
        },
        seq: 2,
      },
    ],
  });
  await jest.advanceTimersByTimeAsync(500);
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual([]);
  expect(state?.error).toBeUndefined();
  // (c) One delta among two unchanged messages: unstored siblings keep their identity in
  // state.messages and assetURLs is untouched, so the expected gap set is empty.
  const beforeFirst = state?.messages[0];
  socket.frame(
    'session.text.delta',
    {
      syncPosition: 9,
      data: { data: { assistantMessageID: 'msg_second', ordinal: 0, delta: '!' } },
    },
    8,
    'events'
  );

  await flush();
  expect(state?.messages[1]?.message.content).toEqual([{ type: 'text', text: 'two!' }]);
  expect(state?.messages[0]?.message).toBe(beforeFirst?.message);
  expect(state?.pendingSnapshotMessageIDs).toEqual([]);
  expect(state?.error).toBeUndefined();
  socket.frame(
    'session.text.delta',
    { data: { data: { assistantMessageID: 'msg_unknown', ordinal: 0, delta: 'x' } } },
    9,
    'events'
  );
  await flush();
  // (b) A delta for a message id absent from the transcript neither appends messages nor
  // reports a gap.
  expect(state?.messages).toHaveLength(2);
  expect(state?.pendingSnapshotMessageIDs).toEqual([]);
  connection.close();
});

test('a replaced native asset re-reports stale references through already covered unchanged messages', async () => {
  const staleKey = kilo2AssetKey('msg_stale_000000_file_0', 'file:///owned/stale.png', 'image/png');
  const otherKey = kilo2AssetKey('msg_other_000000_file_0', 'file:///owned/other.png', 'image/png');
  snapshot.mockResolvedValue({
    position: 5,
    revision: 2,
    session: sessionMetadata,
    entities: [],
    assetURLs: { [otherKey]: 'data:image/png;base64,b3RoZXI=' },
    messages: [
      {
        message: {
          id: 'msg_stale',
          type: 'assistant',
          time: { created: 1, completed: 5 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 1 },
              state: {
                status: 'completed',
                input: { path: 'stale.png' },
                content: [{ type: 'file', uri: 'file:///owned/stale.png', mime: 'image/png' }],
              },
            },
          ],
        },
        seq: 1,
      },
      {
        message: {
          id: 'msg_other',
          type: 'assistant',
          time: { created: 1, completed: 5 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 2 },
              state: {
                status: 'completed',
                input: { path: 'other.png' },
                content: [{ type: 'file', uri: 'file:///owned/other.png', mime: 'image/png' }],
              },
            },
          ],
        },
        seq: 2,
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
  socket.frame('hello', hello(), 3);
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toBeUndefined();
  // (d) Replacing msg_other's resolved content deletes its asset key, and the identity
  // change re-runs the scan over the untouched msg_stale whose key was never stored.
  socket.frame(
    'session.message.content.updated',
    {
      syncPosition: 6,
      data: {
        data: {
          sessionID: 'ses_a',
          messageID: 'msg_other',
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 3 },
              state: {
                status: 'completed',
                input: { path: 'other.png' },
                content: [{ type: 'file', uri: 'file:///owned/other.png', mime: 'image/png' }],
              },
            },
          ],
        },
      },
    },
    6,
    'events'
  );
  await flush();
  expect(state?.assetURLs?.[otherKey]).toBeUndefined();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_stale', 'msg_other']);
  snapshot.mockResolvedValueOnce({
    ...complete(6),
    assetURLs: {
      [staleKey]: 'data:image/png;base64,c3RhbGU=',
      [otherKey]: 'data:image/png;base64,b3RoZXI=',
    },
    messages: [
      {
        message: {
          id: 'msg_stale',
          type: 'assistant',
          time: { created: 1, completed: 6 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 1 },
              state: {
                status: 'completed',
                input: { path: 'stale.png' },
                content: [{ type: 'file', uri: 'file:///owned/stale.png', mime: 'image/png' }],
              },
            },
          ],
        },
        seq: 1,
      },
      {
        message: {
          id: 'msg_other',
          type: 'assistant',
          time: { created: 1, completed: 6 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 3 },
              state: {
                status: 'completed',
                input: { path: 'other.png' },
                content: [{ type: 'file', uri: 'file:///owned/other.png', mime: 'image/png' }],
              },
            },
          ],
        },
        seq: 2,
      },
    ],
  });
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  // The covering read resolves the stale key, but msg_other's pending id survives it: the
  // recovery filter keeps only ids a live replay still requires.
  expect(state?.assetURLs?.[staleKey]).toBe('data:image/png;base64,c3RhbGU=');
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_other']);
  snapshot.mockResolvedValueOnce({ ...complete(6), revision: 4 });
  await jest.advanceTimersByTimeAsync(800);
  await flush();
  // The finished recovery keeps the replaced message's pending id because the relay still
  // owes its live replay; the same socket stays up the whole time.
  expect(state?.error).toBeUndefined();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_other']);
  expect(FakeSocket.sockets).toHaveLength(1);
  connection.close();
});

test('an unresolved private asset keeps the notice and starts recovery', async () => {
  const key = kilo2AssetKey('msg_file_000000_file_0', 'file:///owned/stale.png', 'image/png');
  const fileMessage = {
    message: {
      id: 'msg_file',
      type: 'assistant',
      time: { created: 1, completed: 5 },
      content: [
        {
          type: 'tool',
          id: 'call',
          name: 'read',
          time: { created: 1, ran: 1, completed: 1 },
          state: {
            status: 'completed' as const,
            input: { path: 'stale.png' },
            content: [{ type: 'file', uri: 'file:///owned/stale.png', mime: 'image/png' }],
          },
        },
      ],
    },
    seq: 1,
  };
  snapshot.mockResolvedValueOnce({
    position: 5,
    revision: 2,
    session: sessionMetadata,
    entities: [],
    messages: [fileMessage],
  });
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello(), 3);
  await flush();
  if (!state) throw new Error('Missing native state');
  expect(state.error).toBeUndefined();
  // No pending identity names this message, yet the unresolved asset is a gap, so recovery
  // reads the canonical snapshot that can authorize its bytes.
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  expect(snapshot.mock.calls.length).toBeGreaterThan(1);
  // A published failure stays visible through `subscribed` while the transcript is still gapped.
  connectedSocket().frame('error', { code: 'Session command failed' });
  await flush();
  expect(state.error).toBe('Session command failed');
  connectedSocket().frame('subscribed', { seq: 6 }, 6);
  await flush();
  expect(state.error).toBe('Session command failed');
  snapshot.mockResolvedValueOnce({
    position: 6,
    revision: 3,
    session: sessionMetadata,
    entities: [],
    assetURLs: { [key]: 'data:image/png;base64,c3RhbGU=' },
    messages: [fileMessage],
  });
  await jest.advanceTimersByTimeAsync(500);
  await flush();
  expect(state.pendingSnapshotMessageIDs).toBeUndefined();
  expect(state.error).toBeUndefined();
  expect(readNativeConversation(state).error).toBeUndefined();
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
  expect(readNativeConversation(state)).toMatchObject({ recoveryGaps: 1, error: undefined });
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

test('requestRecovery retries missing parts over the live socket and resolves once they arrive', async () => {
  const initial: NativeSnapshot = {
    position: 1,
    revision: 1,
    session: sessionMetadata,
    entities: [],
    messages: [],
  };
  snapshot.mockResolvedValue(initial);
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
    'session.moved',
    {
      syncPosition: 1,
      data: { data: { sessionID: 'ses_a', location: { directory: '/after' } } },
    },
    2,
    'events'
  );
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_2']);
  // Let the automatic run reach its bound, so the retry below is the only recovery left.
  await jest.advanceTimersByTimeAsync(3750);
  await flush();
  expect(state?.error).toContain('incomplete');
  const sockets = FakeSocket.sockets.length;
  const reads = snapshot.mock.calls.length;
  snapshot.mockResolvedValue({
    ...initial,
    position: 2,
    revision: 2,
    messages: [
      {
        seq: 2,
        message: {
          id: 'msg_2',
          type: 'location-switched',
          time: { created: 2 },
          location: { directory: '/after' },
          previous: { location: { directory: '/before' } },
        },
      },
    ],
  });
  const recovered = connection.requestRecovery();
  await jest.advanceTimersByTimeAsync(250);
  await flush();
  await recovered;
  // The same socket carried the retry: no reconnect, no teardown.
  expect(FakeSocket.sockets.length).toBe(sockets);
  expect(snapshot.mock.calls.length).toBe(reads + 1);
  expect(state?.pendingSnapshotMessageIDs).toEqual([]);
  expect(state?.error).toBeUndefined();
  if (!state) throw new Error('Missing recovered state');
  expect(readNativeConversation(state).recoveryGaps).toBe(0);
  // Nothing is missing any more, so a later retry resolves without reading a snapshot.
  const clean = snapshot.mock.calls.length;
  await connection.requestRecovery();
  expect(snapshot.mock.calls.length).toBe(clean);
  connection.close();
});

test('binary snapshot assets share organization grants, renew a 401, and preserve cancellation', async () => {
  const { client, fetcher, calls } = fixture();
  const ordinary = fetcher.getMockImplementation();
  if (!ordinary) throw new Error('Missing fetch fixture');
  const authorizations: (string | null)[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const controller = new AbortController();
  let assetCalls = 0;
  let holdAsset = false;
  let heldAsset: (response: Response) => void = () => {};
  fetcher.mockImplementation(async (input, init) => {
    if (!new URL(String(input)).pathname.endsWith('/blobs/owned')) return ordinary(input, init);
    authorizations.push(new Headers(init?.headers).get('Authorization'));
    signals.push(init?.signal);
    // The exchange owns the signal it hands the fetcher; caller cancellation reaches it through
    // a listener, so the caller's own signal is not the one on the wire.
    expect(init?.signal?.aborted).toBe(false);
    assetCalls++;
    if (assetCalls === 1) return Response.json({ error: { code: 'expired' } }, { status: 401 });
    if (holdAsset)
      return new Promise<Response>(resolve => {
        heldAsset = resolve;
      });
    return new Response(new Uint8Array([1, 2, 3]).buffer);
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
  holdAsset = true;
  const stalled = client.getSnapshot('ses_a', 'organization-owned', controller.signal);
  let settled = 'pending';
  void stalled.then(
    () => {
      settled = 'resolved';
    },
    (error: { code?: string }) => {
      settled = error.code ?? 'failed';
    }
  );
  await flush();
  expect(assetCalls).toBe(3);
  const wire = signals[signals.length - 1];
  expect(wire?.aborted).toBe(false);
  controller.abort();
  await flush();
  expect(settled).toBe('request_canceled');
  expect(wire?.aborted).toBe(true);
  await expect(stalled).rejects.toMatchObject({ code: 'request_canceled' });
  heldAsset(new Response(new Uint8Array([1, 2, 3]).buffer));
  await flush();
  expect(assetCalls).toBe(3);
});

/** One stored attachment page; `advertisedBytes` is what the mapping authorizes. */
function assetSnapshotPage(advertisedBytes = 3) {
  const hash = 'c'.repeat(64);
  const reference = `media:${hash}`;
  return {
    hash,
    reference,
    page: {
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
    },
  };
}

function assetSnapshotFixture(response: Response, advertisedBytes = 3) {
  const { client, fetcher } = fixture();
  const ordinary = fetcher.getMockImplementation();
  if (!ordinary) throw new Error('Missing fetch fixture');
  const { hash, page: entitiesPage } = assetSnapshotPage(advertisedBytes);
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
    if (path === '/v1/sessions/ses_a/entities') return Response.json(entitiesPage);
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

test('closing a live session drops its retained attachment bodies', async () => {
  const { client, fetcher } = fixture();
  const ordinary = fetcher.getMockImplementation();
  if (!ordinary) throw new Error('Missing fetch fixture');
  const { hash, page: entitiesPage } = assetSnapshotPage(3);
  let blobReads = 0;
  fetcher.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith(`/blobs/${hash}`)) {
      blobReads++;
      return new Response(new Uint8Array([1, 2, 3]).buffer);
    }
    if (path === '/v1/sessions/ses_a') {
      return Response.json({
        version: 1,
        sessionID: 'ses_a',
        deleted: false,
        position: 1,
        revision: 1,
      });
    }
    if (path === '/v1/sessions/ses_a/entities') return Response.json(entitiesPage);
    return ordinary(input, init);
  });
  const actual =
    jest.requireActual<typeof NativeSnapshotModule>('./native-sync-snapshot').fetchNativeSnapshot;
  snapshot
    .mockImplementationOnce(actual)
    .mockImplementationOnce(actual)
    .mockImplementationOnce(actual);
  const key = kilo2AssetKey('msg_asset_000001', `media:${hash}`, 'image/png');
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  connectedSocket().frame('hello', hello(), 1);
  // Drain microtasks until the hello snapshot has published its resolved attachment.
  for (let tick = 0; tick < 2000 && state?.assetURLs?.[key] === undefined; tick++)
    await Promise.resolve();
  expect(state?.assetURLs?.[key]).toBe('data:image/png;base64,AQID');
  expect(blobReads).toBe(1);
  // A second read answers from the retained body, which proves the body really was retained
  // instead of the later count merely matching a body that was never kept.
  const retained = await client.getSnapshot('ses_a');
  expect(retained.assetURLs?.[key]).toBe('data:image/png;base64,AQID');
  expect(blobReads).toBe(1);
  connection.close();
  await flush();
  const reread = await client.getSnapshot('ses_a');
  expect(reread.assetURLs?.[key]).toBe('data:image/png;base64,AQID');
  expect(blobReads).toBe(2);
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

test('a response whose body never arrives times out like a stalled connect', async () => {
  // Both halves stall after the headers: the success path reads JSON, and the failing status
  // path reads an error body before it can report the status.
  const neverEnding = () => new ReadableStream({ start() {} });
  let stallBody = true;
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/exchange')
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    if (!stallBody) return Response.json({ items: [], cursor: null });
    if (path === '/v1/sessions') return new Response(neverEnding());
    return new Response(neverEnding(), { status: 503 });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  const first = trackOutcome(client.listSessions());
  await flush();
  await jest.advanceTimersByTimeAsync(NATIVE_SYNC_REQUEST_DEADLINE_MS);
  await flush();
  expect(first.code).toBe('request_timeout');
  // A different path reaches the failing status, whose error body stalls the same way.
  const failing = trackOutcome(client.request('/v1/sessions/ses_a/commands'));
  await flush();
  await jest.advanceTimersByTimeAsync(NATIVE_SYNC_REQUEST_DEADLINE_MS);
  await flush();
  expect(failing.code).toBe('request_timeout');
  stallBody = false;
  await expect(client.listSessions()).resolves.toMatchObject({ items: [] });
});

test('a response that arrives after the deadline releases its body', async () => {
  // A fetcher that ignores the abort signal still answers. The late body must be canceled then,
  // not left open until the collector reclaims the stream.
  const cancel = jest.fn(async () => {});
  let release: (response: Response) => void = () => {};
  const held = new Promise<Response>(resolve => {
    release = resolve;
  });
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/exchange')
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    return held;
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  const call = client.listSessions();
  const settled = trackOutcome(call);
  await flush();
  await jest.advanceTimersByTimeAsync(NATIVE_SYNC_REQUEST_DEADLINE_MS);
  await flush();
  expect(settled.code).toBe('request_timeout');
  expect(cancel).not.toHaveBeenCalled();
  release(new Response(new ReadableStream({ cancel })));
  await flush();
  expect(cancel).toHaveBeenCalledTimes(1);
});

test('a stalled grant exchange times out, aborts its request, and is replaced on the next call', async () => {
  let exchanges = 0;
  let stallExchange = true;
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/exchange') {
      exchanges++;
      signals.push(init?.signal);
      if (stallExchange) return new Promise<Response>(() => {});
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    return Response.json({ items: [], cursor: null });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  const call = client.listSessions();
  const settled = trackOutcome(call);
  await flush();
  const wire = signals[0];
  expect(wire?.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(NATIVE_SYNC_REQUEST_DEADLINE_MS);
  await flush();
  expect(settled.code).toBe('request_timeout');
  // The deadline reaches the request itself, not just the promise waiting on it.
  expect(wire?.aborted).toBe(true);
  await expect(call).rejects.toMatchObject({ code: 'request_timeout' });
  // A cached rejected promise would answer the second call without a new exchange.
  stallExchange = false;
  await expect(client.listSessions()).resolves.toMatchObject({ items: [] });
  expect(exchanges).toBe(2);
});

test('a stalled credential lookup times out and leaves the grant cache', async () => {
  // The credential is fetched before the exchange, so a lookup that never settles would leave
  // the cached mint pending forever and every later caller would join it. The lookup is bounded
  // by the same deadline, and its failure evicts the entry so the next call mints again.
  let exchanges = 0;
  let release: (credential: string) => void = () => {};
  let captured: AbortSignal | undefined;
  // ES2022/Hermes consumers do not provide Promise.withResolvers.
  const held = new Promise<string>(resolve => {
    release = resolve;
  });
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/exchange') {
      exchanges++;
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    return Response.json({ items: [], cursor: null });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: signal => {
      captured = signal;
      return held;
    },
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  const call = client.listSessions();
  const settled = trackOutcome(call);
  await flush();
  // No exchange is attempted while the credential is unread.
  expect(settled.code).toBe('pending');
  expect(exchanges).toBe(0);
  expect(captured).toBeInstanceOf(AbortSignal);
  expect(captured?.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(NATIVE_SYNC_REQUEST_DEADLINE_MS);
  await flush();
  expect(settled.code).toBe('request_timeout');
  // The deadline aborts the signal the source received, so its own request can stop too.
  expect(captured?.aborted).toBe(true);
  await expect(call).rejects.toMatchObject({ code: 'request_timeout' });
  release('kilo-credential');
  // The dead entry left the cache, so this call mints once more instead of joining it.
  await expect(client.listSessions()).resolves.toMatchObject({ items: [] });
  expect(exchanges).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('a healthy credential lookup receives a signal that is never aborted', async () => {
  // The signal is a deadline, not a cancellation of a working lookup, so a mint that finishes
  // in time must hand the source a signal that stays live only until the timer is cleared.
  let captured: AbortSignal | undefined;
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/exchange') {
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    return Response.json({ items: [], cursor: null });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: signal => {
      captured = signal;
      return Promise.resolve('kilo-credential');
    },
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  await expect(client.listSessions()).resolves.toMatchObject({ items: [] });
  expect(captured).toBeInstanceOf(AbortSignal);
  expect(captured?.aborted).toBe(false);
  // The mint cleared its timer, so no later tick of the deadline can abort the passed signal.
  await jest.advanceTimersByTimeAsync(NATIVE_SYNC_REQUEST_DEADLINE_MS);
  expect(captured?.aborted).toBe(false);
});

test('two callers minting at once keep the newer grant when the older exchange fails', async () => {
  // Both callers see the same expired entry and start their own exchange. The older one fails
  // after the newer one was cached; the shared entry must stay, and later calls reuse it.
  let exchanges = 0;
  // Fresh enough for the first call, stale once the clock advances past the reuse margin.
  const expiresAt = new Date(Date.now() + 31_000).toISOString();
  // ES2022/Hermes consumers do not provide Promise.withResolvers.
  let rejectOlder: (error: Error) => void = () => {};
  let resolveNewer: (response: Response) => void = () => {};
  const older = new Promise<Response>((_resolve, reject) => {
    rejectOlder = reject;
  });
  const newer = new Promise<Response>(resolve => {
    resolveNewer = resolve;
  });
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/exchange') {
      exchanges++;
      if (exchanges === 2) return older;
      if (exchanges === 3) return newer;
      return Response.json({ token: `grant-${exchanges}`, expiresAt });
    }
    return Response.json({ items: [], cursor: null });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  await expect(client.listSessions()).resolves.toMatchObject({ items: [] });
  expect(exchanges).toBe(1);
  await jest.advanceTimersByTimeAsync(2000);
  const first = trackOutcome(client.listSessions());
  const second = trackOutcome(client.listSessions());
  await flush();
  expect(exchanges).toBe(3);
  // The newer exchange wins the cache; the older one then fails.
  resolveNewer(
    Response.json({
      token: 'grant-newer',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })
  );
  await flush();
  rejectOlder(new Error('offline'));
  await flush();
  // The caller whose own exchange failed reports that failure.
  expect(first.code).toBe('failed');
  expect(second.code).toBe('resolved');
  await expect(client.listSessions()).resolves.toMatchObject({ items: [] });
  // The newer entry survived, so the shared cache answers without a fourth exchange.
  expect(exchanges).toBe(3);
});

test('two concurrent 401s renew the grant once', async () => {
  // Both callers hold the same cached grant and both receive a 401. One caller's catch must not
  // delete the renewal the other already installed, or both callers exchange again.
  let exchanges = 0;
  let rejections = 0;
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/exchange') {
      exchanges++;
      return Response.json({
        token: `grant-${exchanges}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    // The two requests made with the cached grant fail; the retries use the renewal.
    if (rejections > 0) {
      rejections--;
      return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    }
    return Response.json({ items: [], cursor: null });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  await expect(client.listSessions()).resolves.toMatchObject({ items: [] });
  expect(exchanges).toBe(1);
  // Both concurrent requests are answered by the cached grant and both get a 401.
  rejections = 2;
  const first = trackOutcome(client.listSessions());
  const second = trackOutcome(client.listSessions());
  await flush();
  expect(exchanges).toBe(2);
  await flush();
  expect(first.code).toBe('resolved');
  expect(second.code).toBe('resolved');
  // A second renewal round after both calls settled would raise this beyond two.
  expect(exchanges).toBe(2);
});

test('a stalled ticket mint reaches the connect backoff', async () => {
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  let stallTicket = true;
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/exchange'))
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    if (path.endsWith('live-ticket')) {
      if (stallTicket) return new Promise<Response>(() => {});
      return Response.json({
        ticket: 'private-ticket',
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      });
    }
    return Response.json({ status: 'queued' });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  try {
    await flush();
    expect(state?.connection).toBe('connecting');
    await jest.advanceTimersByTimeAsync(NATIVE_SYNC_REQUEST_DEADLINE_MS);
    await flush();
    expect(state?.connection).toBe('disconnected');
    stallTicket = false;
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(FakeSocket.sockets).toHaveLength(1);
    connectedSocket().frame('hello', hello());
    await flush();
    expect(state?.connection).toBe('connected');
  } finally {
    random.mockRestore();
    connection.close();
  }
});

test('a slow but successful mint chain fails at one total deadline instead of three hops', async () => {
  // The mint is a credential lookup, a grant exchange and a ticket POST, each with its own
  // request deadline. Hops that all succeed would therefore each stay under their own bound and
  // still hold `connecting` for 20 s here. This pins the total bound: the chain fails at one
  // deadline, cancels the hop in flight, and the first failure reaches the existing backoff.
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  // Every `setTimeout` below runs on the fake clock `beforeEach` installs, so the hops cost no
  // wall time, and ES2022/Hermes consumers do not provide Promise.withResolvers.
  let slow = true;
  const delayed = (ms: number, answer: () => Response) =>
    new Promise<Response>(resolve => setTimeout(() => resolve(answer()), ms));
  const ticketPostSignals: (AbortSignal | null | undefined)[] = [];
  const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/exchange'))
      return slow
        ? delayed(5_000, () =>
            Response.json({
              token: 'grant',
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            })
          )
        : Response.json({
            token: 'grant',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          });
    if (path.endsWith('live-ticket')) {
      ticketPostSignals.push(init?.signal);
      const answer = () =>
        Response.json({
          ticket: 'private-ticket',
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
        });
      // Starts at 10 s and would succeed at 20 s, past the 15 s total bound.
      return slow ? delayed(10_000, answer) : answer();
    }
    return Response.json({ status: 'queued' });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: () =>
      slow
        ? new Promise<string>(resolve => setTimeout(() => resolve('kilo-credential'), 5_000))
        : Promise.resolve('kilo-credential'),
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  try {
    await flush();
    expect(state?.connection).toBe('connecting');
    await jest.advanceTimersByTimeAsync(14_000);
    await flush();
    expect(state?.connection).toBe('connecting');
    expect(ticketPostSignals).toHaveLength(1);
    expect(ticketPostSignals[0]?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(state?.connection).toBe('disconnected');
    expect(state?.error).toBe('request_timeout');
    // The hop in flight is cancelled at the bound instead of running to its own success.
    expect(ticketPostSignals[0]?.aborted).toBe(true);
    slow = false;
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(ticketPostSignals).toHaveLength(2);
    expect(FakeSocket.sockets).toHaveLength(1);
    connectedSocket().frame('hello', hello());
    await flush();
    expect(state?.connection).toBe('connected');
  } finally {
    random.mockRestore();
    connection.close();
  }
});

test('a caller abort during a stalled exchange stays request_canceled', async () => {
  const controller = new AbortController();
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/exchange')
      return Response.json({
        token: 'grant',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    signals.push(init?.signal);
    if (path === '/v1/sessions/ses_a') return new Promise<Response>(() => {});
    return Response.json({ status: 'queued' });
  });
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential: async () => 'kilo-credential',
    fetch: fetcher,
    WebSocket: FakeSocket,
  });
  snapshot.mockImplementationOnce(async (request, sessionID) => {
    await request(`/v1/sessions/${sessionID}`, { signal: controller.signal });
    return { position: 0, revision: 1, session: sessionMetadata, entities: [], messages: [] };
  });
  const pending = client.getSnapshot('ses_a', undefined, controller.signal);
  const settled = trackOutcome(pending);
  await flush();
  const wire = signals.at(-1);
  expect(wire?.aborted).toBe(false);
  controller.abort();
  await flush();
  expect(settled.code).toBe('request_canceled');
  // The caller's cancellation reaches the request, and the later deadline does not rewrite it.
  expect(wire?.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(NATIVE_SYNC_REQUEST_DEADLINE_MS);
  await flush();
  expect(settled.code).toBe('request_canceled');
  await expect(pending).rejects.toMatchObject({ code: 'request_canceled' });
});

const mediaHash = 'd'.repeat(64);
const mediaReference = `media:${mediaHash}`;
const mediaKey = kilo2AssetKey('msg_keep_000000_file_0', mediaReference, 'image/png');
const attachmentTranscript: NativeSnapshot = {
  position: 5,
  revision: 2,
  session: sessionMetadata,
  entities: [],
  assetURLs: { [mediaKey]: 'data:image/png;base64,bWVkaWE=' },
  messages: [
    {
      seq: 1,
      message: {
        id: 'msg_keep',
        type: 'assistant',
        time: { created: 1, completed: 5 },
        content: [
          {
            type: 'tool',
            id: 'call',
            name: 'read',
            time: { created: 1, ran: 1, completed: 1 },
            state: {
              status: 'completed',
              input: { path: 'image.png' },
              content: [{ type: 'file', uri: mediaReference, mime: 'image/png' }],
            },
          },
        ],
      },
    },
    {
      seq: 2,
      message: {
        id: 'msg_answer',
        type: 'assistant',
        time: { created: 1 },
        content: [{ type: 'text', text: '' }],
      },
    },
  ],
};

test('streamed deltas leave an unchanged message with a private attachment as a full recompute does', async () => {
  snapshot.mockResolvedValue(attachmentTranscript);
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 1);
  await flush();
  expect(state?.assetURLs?.[mediaKey]).toBe('data:image/png;base64,bWVkaWE=');
  const kept = state?.messages[0];
  const assets = state?.assetURLs;
  for (let index = 0; index < 5; index++) {
    socket.frame(
      'session.text.delta',
      {
        syncPosition: 6,
        data: { data: { assistantMessageID: 'msg_answer', ordinal: 0, delta: `${index}` } },
      },
      2 + index,
      'events'
    );
    await flush();
  }
  expect(state?.messages[1]?.message.content).toEqual([{ type: 'text', text: '01234' }]);
  // The untouched attachment keeps its exact entry and authorization across every delta.
  expect(state?.messages[0]).toBe(kept);
  expect(state?.assetURLs).toBe(assets);
  expect(state?.pendingSnapshotMessageIDs).toBeUndefined();
  // A frame that needs the whole transcript reaches exactly the same conclusion.
  socket.frame(
    'session.inbox.delivered',
    { syncPosition: 7, data: { data: { inboxID: 'msg_missing' } } },
    20,
    'events'
  );
  await flush();
  expect(state?.messages[0]).toBe(kept);
  expect(state?.assetURLs).toBe(assets);
  expect(state?.pendingSnapshotMessageIDs).toBeUndefined();
  expect(state?.error).toBeUndefined();
  connection.close();
});

test('a replaced file still drops its asset key after deltas kept the per-id map current', async () => {
  const uri = 'file:///owned/report.png';
  const key = kilo2AssetKey('msg_file_000000_file_0', uri, 'image/png');
  const fileContent = [{ type: 'file', uri, mime: 'image/png' }];
  snapshot.mockResolvedValue({
    position: 4,
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
          time: { created: 1, completed: 4 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 1 },
              state: { status: 'completed', input: { path: 'report.png' }, content: fileContent },
            },
          ],
        },
      },
      {
        seq: 2,
        message: {
          id: 'msg_answer',
          type: 'assistant',
          time: { created: 1 },
          content: [{ type: 'text', text: '' }],
        },
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
  socket.frame('hello', hello(), 1);
  await flush();
  // A fresh authoritative read rebuilds the per-id map from its own transcript.
  socket.frame('reset_required', { seq: 1 }, 1);
  await flush();
  for (let index = 0; index < 3; index++) {
    socket.frame(
      'session.text.delta',
      {
        syncPosition: 5,
        data: { data: { assistantMessageID: 'msg_answer', ordinal: 0, delta: 'x' } },
      },
      2 + index,
      'events'
    );
    await flush();
  }
  expect(state?.assetURLs?.[key]).toBe('data:image/png;base64,b2xk');
  socket.frame(
    'session.message.content.updated',
    {
      syncPosition: 6,
      data: {
        data: {
          messageID: 'msg_file',
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 2 },
              state: { status: 'completed', input: { path: 'report.png' }, content: fileContent },
            },
          ],
        },
      },
    },
    6,
    'events'
  );
  await flush();
  expect(state?.assetURLs?.[key]).toBeUndefined();
  expect(state?.pendingSnapshotMessageIDs).toEqual(['msg_file']);
  // The same replaced entry reports the same gap through the whole-transcript path.
  const pendingIDs = state?.pendingSnapshotMessageIDs;
  socket.frame(
    'session.inbox.delivered',
    { syncPosition: 7, data: { data: { inboxID: 'msg_missing' } } },
    7,
    'events'
  );
  await flush();
  expect(state?.pendingSnapshotMessageIDs).toEqual(pendingIDs ?? []);
  expect(state?.assetURLs?.[key]).toBeUndefined();
  connection.close();
});

test('a local clear keeps hiding the ids it cleared while later traffic re-creates them', async () => {
  snapshot.mockResolvedValue({
    position: 1,
    revision: 1,
    session: sessionMetadata,
    entities: [],
    messages: [
      {
        seq: 1,
        message: {
          id: 'msg_old',
          type: 'assistant',
          time: { created: 1 },
          content: [{ type: 'text', text: 'gone' }],
        },
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
  socket.frame('hello', hello(), 1);
  await flush();
  expect(state?.messages.map(item => item.message.id)).toEqual(['msg_old']);
  connection.clear();
  expect(state?.messages).toEqual([]);
  socket.frame(
    'session.inbox.enqueued',
    {
      syncPosition: 2,
      data: {
        data: {
          inboxID: 'msg_old',
          item: { type: 'user', payload: { text: 'again', type: 'user' } },
        },
      },
    },
    2,
    'events'
  );
  await flush();
  expect(state?.messages).toEqual([]);
  socket.frame(
    'session.step.started',
    { syncPosition: 3, data: { data: { assistantMessageID: 'msg_old' } } },
    3,
    'events'
  );
  await flush();
  expect(state?.messages).toEqual([]);
  socket.frame(
    'session.step.started',
    { syncPosition: 4, data: { data: { assistantMessageID: 'msg_fresh' } } },
    4,
    'events'
  );
  await flush();
  expect(state?.messages.map(item => item.message.id)).toEqual(['msg_fresh']);
  connection.close();
});

test('the published ring keeps the remote state plus at most 499 live frames and resets on remote state', async () => {
  const { client } = fixture();
  let state: NativeSessionState | undefined;
  const connection = client.connectSession('ses_a', value => {
    state = value;
  });
  await flush();
  const socket = connectedSocket();
  socket.frame('hello', hello(), 1);
  await flush();
  const initial = state?.events;
  for (let index = 0; index < 520; index++) {
    socket.frame(
      'session.text.delta',
      { data: { data: { assistantMessageID: 'msg_absent', ordinal: 0, delta: 'x' } } },
      100 + index,
      'events'
    );
    await flush();
  }
  expect(state?.events).not.toBe(initial);
  expect(state?.events).toHaveLength(499);
  expect(state?.events[0]?.seq).toBe(121);
  expect(state?.events.at(-1)?.seq).toBe(619);
  socket.frame(
    'remote.state',
    { incarnation: 'runner', runID: 'run', pending: { permissions: [], questions: [] } },
    700,
    'events'
  );
  await flush();
  expect(state?.events).toHaveLength(1);
  expect(state?.events[0]?.type).toBe('remote.state');
  for (const seq of [701, 702]) {
    socket.frame(
      'session.text.delta',
      { data: { data: { assistantMessageID: 'msg_absent', ordinal: 0, delta: 'y' } } },
      seq,
      'events'
    );
    await flush();
  }
  expect(state?.events.map(event => event.seq)).toEqual([700, 701, 702]);
  expect(state?.events[0]?.type).toBe('remote.state');
  connection.close();
});

test('a delta skips an unresolved snapshot entry exactly as the whole-transcript scan does', async () => {
  const uri = 'file:///owned/unresolved.png';
  const key = kilo2AssetKey('msg_pending_000000_file_0', uri, 'image/png');
  snapshot.mockResolvedValue({
    position: 4,
    revision: 1,
    session: sessionMetadata,
    entities: [],
    messages: [
      {
        seq: 1,
        message: {
          id: 'msg_pending',
          type: 'assistant',
          time: { created: 1, completed: 4 },
          content: [
            {
              type: 'tool',
              id: 'call',
              name: 'read',
              time: { created: 1, ran: 1, completed: 1 },
              state: {
                status: 'completed',
                input: { path: 'unresolved.png' },
                content: [{ type: 'file', uri, mime: 'image/png' }],
              },
            },
          ],
        },
      },
      {
        seq: 2,
        message: {
          id: 'msg_answer',
          type: 'assistant',
          time: { created: 1 },
          content: [{ type: 'text', text: '' }],
        },
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
  socket.frame('hello', hello(), 1);
  await flush();
  expect(state?.assetURLs?.[key]).toBeUndefined();
  socket.frame(
    'session.text.delta',
    {
      syncPosition: 5,
      data: { data: { assistantMessageID: 'msg_answer', ordinal: 0, delta: 'x' } },
    },
    2,
    'events'
  );
  await flush();
  expect(state?.messages[1]?.message.content).toEqual([{ type: 'text', text: 'x' }]);
  // The unresolved entry keeps its identity, so this frame's scan skips it exactly as the
  // whole-transcript scan does; the attachment stays recovery's job, not this frame's.
  expect(state?.pendingSnapshotMessageIDs).toBeUndefined();
  expect(state?.assetURLs?.[key]).toBeUndefined();
  connection.close();
});
