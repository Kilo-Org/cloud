import { createCliLiveTransport } from './cli-live-transport';
import { createRemoteSessionOnConnection } from './create-session';
import { configureCloudAgentSdkRuntime, resetCloudAgentSdkRuntime } from './runtime';
import { kiloId } from './test-helpers';
import type { CreateRemoteSessionInput, Transport } from './transport';
import {
  CommandDeliveredError,
  createUserWebConnection,
  type UserWebActionTarget,
  type UserWebConnection,
} from './user-web-connection';

const SESSION_ID = kiloId('ses_11111111111111111111111111');
const CREATED_SESSION_ID = 'ses_22222222222222222222222222';
const CREATED = { protocolVersion: 1, sessionID: CREATED_SESSION_ID };
const OWNER_ID = 'cli-owner-1';
const originalWebSocket = globalThis.WebSocket;

type WireFrame = {
  type: string;
  id: string;
  command: string;
  data: unknown;
  sessionId?: string;
  connectionId?: string;
  mutationId?: string;
};

let sockets: TestSocket[] = [];
const clients: UserWebConnection[] = [];
const transports: Transport[] = [];

class TestSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly frames: WireFrame[] = [];

  constructor() {
    sockets.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  send(value: string) {
    const frame = JSON.parse(value) as WireFrame;
    this.frames.push(frame);
    if (frame.command === 'list_models') {
      this.receive({ type: 'response', id: frame.id, error: 'unknown command' });
    } else if (frame.command === 'list_commands') {
      this.receive({
        type: 'response',
        id: frame.id,
        result: { protocolVersion: 1, commands: [], canExitSession: true },
      });
    }
  }

  close() {
    this.readyState = 3;
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  Object.defineProperty(globalThis, 'WebSocket', {
    value: TestSocket,
    configurable: true,
    writable: true,
  });
  let id = 0;
  configureCloudAgentSdkRuntime({ randomUUID: () => `uuid-${++id}` });
});

afterEach(() => {
  for (const transport of transports.splice(0)) transport.destroy();
  for (const client of clients.splice(0)) client.destroy();
  globalThis.WebSocket = originalWebSocket;
  resetCloudAgentSdkRuntime();
  jest.useRealTimers();
});

function effects() {
  return sockets
    .flatMap(socket => socket.frames)
    .filter(
      frame =>
        frame.type === 'command' &&
        frame.command !== 'list_models' &&
        frame.command !== 'list_commands'
    );
}

function setup(withAdmission = true) {
  const owner = { userId: 'user-a', authEpoch: 1, unlockGeneration: 1, unlocked: true };
  const callerScope = { organizationId: 'original-org' };
  const captures: Array<{ target: UserWebActionTarget; organizationId: string }> = [];
  const denied = new Error('Original action admission expired');
  const client = createUserWebConnection({
    websocketUrl: 'wss://localhost:9999/api/user/web',
    getAuthToken: () => 'token',
    ...(withAdmission
      ? {
          captureActionAdmission(target: UserWebActionTarget) {
            const captured = { ...owner };
            const organizationId =
              (target.data as { orgId?: string }).orgId ?? callerScope.organizationId;
            captures.push({ target, organizationId });
            const assert = () => {
              if (
                !owner.unlocked ||
                captured.userId !== owner.userId ||
                captured.authEpoch !== owner.authEpoch ||
                captured.unlockGeneration !== owner.unlockGeneration
              )
                throw denied;
            };
            assert();
            return assert;
          },
        }
      : {}),
  });
  clients.push(client);
  const transport = createCliLiveTransport({
    kiloSessionId: SESSION_ID,
    userWebConnection: client,
  })({
    onChatEvent() {},
    onServiceEvent() {},
  });
  transports.push(transport);
  client.retain();
  transport.connect();
  const socket = sockets[0];
  socket.open();
  socket.receive({
    type: 'system',
    event: 'sessions.list',
    data: {
      sessions: [{ id: SESSION_ID, status: 'idle', title: 'Tracked', connectionId: OWNER_ID }],
    },
  });
  const createSession = transport.createSession;
  if (!createSession) throw new Error('Expected CLI createSession');
  return {
    owner,
    callerScope,
    captures,
    denied,
    client,
    transport,
    socket,
    create(kind: 'session' | 'connection', input?: CreateRemoteSessionInput) {
      return kind === 'session'
        ? createSession(input)
        : createRemoteSessionOnConnection(client, OWNER_ID, input);
    },
  };
}

describe.each(['session', 'connection'] as const)(
  '%s-scoped create compatibility admission',
  kind => {
    it.each(['lock/unlock', 'account replacement', 'auth epoch'] as const)(
      'does not recapture or send the bare retry after %s',
      async change => {
        const harness = setup();
        await jest.advanceTimersByTimeAsync(0);
        const result = harness
          .create(kind, { agent: 'code', orgId: 'original-org', mutationId: 'intent' })
          .catch((error: unknown) => error);
        expect(harness.captures).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(0);
        const first = effects()[0];
        expect(first.command).toBe('create_session');
        if (change === 'account replacement') harness.owner.userId = 'user-b';
        else if (change === 'auth epoch') harness.owner.authEpoch += 1;
        else {
          harness.owner.unlocked = false;
          harness.owner.unlockGeneration += 1;
          harness.owner.unlocked = true;
        }
        harness.socket.receive({
          type: 'response',
          id: first.id,
          error: 'invalid create_session command',
        });
        await jest.advanceTimersByTimeAsync(0);

        expect(effects()).toEqual([first]);
        await expect(result).resolves.toBe(harness.denied);
        expect(harness.captures).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(1000);
        expect(effects()).toEqual([first]);
      }
    );

    it.each([true, false])(
      'preserves valid retries and wire IDs with admission=%s',
      async withAdmission => {
        const harness = setup(withAdmission);
        await jest.advanceTimersByTimeAsync(0);
        const result = harness.create(kind, {
          agent: 'code',
          orgId: 'original-org',
          directory: 'src/app',
          mutationId: 'intent',
        });
        await jest.advanceTimersByTimeAsync(0);
        const first = effects()[0];
        expect(first).toEqual({
          type: 'command',
          id: expect.any(String),
          command: 'create_session',
          connectionId: OWNER_ID,
          ...(kind === 'session' ? { sessionId: SESSION_ID } : {}),
          mutationId: kind === 'session' ? 'intent' : 'intent:ext',
          data: { protocolVersion: 1, agent: 'code', orgId: 'original-org', directory: 'src/app' },
        });
        harness.callerScope.organizationId = 'later-global-org';
        harness.socket.receive({
          type: 'response',
          id: first.id,
          error: 'invalid create_session command',
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(effects()).toHaveLength(2);
        const second = effects()[1];
        expect(second).toEqual({
          type: 'command',
          id: expect.any(String),
          command: 'create_session',
          connectionId: OWNER_ID,
          ...(kind === 'session' ? { sessionId: SESSION_ID } : {}),
          mutationId: kind === 'session' ? expect.any(String) : 'intent:bare',
          data: { protocolVersion: 1 },
        });
        expect(second.id).not.toBe(first.id);
        expect(second.mutationId).not.toBe(first.mutationId);
        expect(harness.captures).toHaveLength(withAdmission ? 1 : 0);
        if (withAdmission) expect(harness.captures[0].organizationId).toBe('original-org');
        harness.socket.receive({ type: 'response', id: second.id, result: CREATED });
        await expect(result).resolves.toEqual(kind === 'session' ? CREATED_SESSION_ID : CREATED);
      }
    );

    it.each([
      ['no extended fields', undefined],
      ['clone only', { cloneFromKiloSessionId: SESSION_ID }],
      ['clone with extended fields', { cloneFromKiloSessionId: SESSION_ID, agent: 'code' }],
    ] satisfies Array<[string, CreateRemoteSessionInput | undefined]>)(
      'does not bare-retry with %s',
      async (_name, input) => {
        const harness = setup();
        await jest.advanceTimersByTimeAsync(0);
        const result = harness.create(kind, input).catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(0);
        const first = effects()[0];
        harness.socket.receive({
          type: 'response',
          id: first.id,
          error: 'invalid create_session command',
        });
        await jest.advanceTimersByTimeAsync(0);

        expect(effects()).toEqual([first]);
        await expect(result).resolves.toBeInstanceOf(CommandDeliveredError);
        expect(harness.captures).toHaveLength(1);
      }
    );
  }
);

const actions: Array<{
  command: string;
  run: (transport: Transport) => Promise<unknown> | undefined;
  data: unknown;
  response?: unknown;
  result?: unknown;
}> = [
  {
    command: 'send_message',
    run: transport => transport.send?.({ payload: { type: 'prompt', prompt: 'hello' } }),
    data: { sessionID: SESSION_ID, parts: [{ type: 'text', text: 'hello' }] },
  },
  {
    command: 'send_command',
    run: transport =>
      transport.send?.({ payload: { type: 'command', command: 'review', arguments: 'changes' } }),
    data: { protocolVersion: 1, command: 'review', arguments: 'changes' },
  },
  { command: 'interrupt', run: transport => transport.interrupt?.(), data: {} },
  {
    command: 'question_reply',
    run: transport => transport.answer?.({ requestId: 'q', answers: [['yes']] }),
    data: { requestID: 'q', answers: [['yes']] },
  },
  {
    command: 'question_reject',
    run: transport => transport.reject?.({ requestId: 'q' }),
    data: { requestID: 'q' },
  },
  {
    command: 'permission_respond',
    run: transport => transport.respondToPermission?.({ requestId: 'p', response: 'once' }),
    data: { requestID: 'p', reply: 'once', interactive: true },
  },
  {
    command: 'suggestion_accept',
    run: transport => transport.acceptSuggestion?.({ requestId: 's', index: 1 }),
    data: { requestID: 's', index: 1 },
  },
  {
    command: 'suggestion_dismiss',
    run: transport => transport.dismissSuggestion?.({ requestId: 's' }),
    data: { requestID: 's' },
  },
  {
    command: 'create_session',
    run: transport => transport.createSession?.({ agent: 'code' }),
    data: { protocolVersion: 1, agent: 'code' },
    response: CREATED,
    result: CREATED_SESSION_ID,
  },
  {
    command: 'exit_cli',
    run: transport => transport.exitSession?.(),
    data: { protocolVersion: 1 },
    response: {},
  },
];

describe.each(actions)('CLI $command admission', action => {
  it.each([true, false])('sends only with valid final admission=%s', async admitted => {
    const harness = setup();
    await jest.advanceTimersByTimeAsync(0);
    const pending = action.run(harness.transport);
    if (!pending) throw new Error(`Expected CLI action ${action.command}`);
    const result = pending.catch((error: unknown) => error);
    harness.owner.unlocked = admitted;
    await jest.advanceTimersByTimeAsync(0);

    if (!admitted) {
      expect(effects()).toEqual([]);
      await expect(result).resolves.toBe(harness.denied);
      return;
    }
    expect(effects()).toHaveLength(1);
    const frame = effects()[0];
    expect(frame).toMatchObject({
      type: 'command',
      command: action.command,
      sessionId: SESSION_ID,
      connectionId: OWNER_ID,
      data: action.data,
    });
    harness.socket.receive({
      type: 'response',
      id: frame.id,
      result: action.response ?? { accepted: true },
    });
    await expect(result).resolves.toEqual(
      action.command === 'exit_cli' ? undefined : (action.result ?? { accepted: true })
    );
    expect(harness.captures).toHaveLength(1);
  });
});
