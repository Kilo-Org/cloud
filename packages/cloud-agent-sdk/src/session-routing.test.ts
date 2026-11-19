/**
 * Tests for session transport routing — verifies that resolveSession
 * correctly routes to Cloud Agent, CLI live, or CLI historical transports.
 */
import { createCloudAgentSession } from './session';
import type { ResolvedSession } from './types';
import type { SessionActivity, AgentStatus } from './types';
import { kiloId, cloudAgentId, makeSnapshot, stubUserMessage, stubTextPart } from './test-helpers';

type MockWebSocket = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: jest.Mock;
  send: jest.Mock;
  readyState: number;
};

let mockWs: MockWebSocket;
let webSocketConstructor: jest.Mock;

beforeEach(() => {
  mockWs = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: jest.fn(),
    send: jest.fn(),
    readyState: 1,
  };

  webSocketConstructor = jest.fn(() => mockWs);

  // @ts-expect-error -- minimal WebSocket mock for testing
  global.WebSocket = webSocketConstructor;
  (global.WebSocket as unknown as Record<string, number>).OPEN = 1;
});

afterEach(() => {
  // @ts-expect-error -- cleanup global mock
  delete global.WebSocket;
});

const SES_ID = 'ses-1';

type StateCapture = { activity: SessionActivity; status: AgentStatus };

function captureStates(session: ReturnType<typeof createCloudAgentSession>): StateCapture[] {
  const states: StateCapture[] = [];
  session.state.subscribe(() => {
    states.push({
      activity: structuredClone(session.state.getActivity()),
      status: structuredClone(session.state.getStatus()),
    });
  });
  return states;
}

describe('session transport routing', () => {
  describe('resolveSession returning Cloud Agent session', () => {
    it('creates Cloud Agent transport with resolved cloudAgentSessionId', async () => {
      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({
          type: 'cloud-agent',
          kiloSessionId: kiloId('ses-1'),
          cloudAgentSessionId: cloudAgentId('do-456'),
        })
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        websocketBaseUrl: 'ws://localhost:9999',
        transport: {
          getTicket: () => 'test-ticket',
          fetchSnapshot: () => Promise.resolve(makeSnapshot({ id: 'ses-1' })),
          api: {
            send: () => Promise.resolve(),
            interrupt: () => Promise.resolve(),
            answer: () => Promise.resolve(),
            reject: () => Promise.resolve(),
            respondToPermission: () => Promise.resolve(),
          },
        },
      });

      session.connect();
      await Promise.resolve(); // resolveSession resolves
      await new Promise(r => setTimeout(r, 0)); // Promise.all([ticket, snapshot]).then settles

      expect(resolveSession).toHaveBeenCalledWith('ses-1');
      expect(webSocketConstructor).toHaveBeenCalledTimes(1);
      const url = webSocketConstructor.mock.calls[0][0] as string;
      expect(url).toContain('cloudAgentSessionId=do-456');

      session.destroy();
    });
  });

  describe('resolveSession returning remote session', () => {
    it('creates CLI live transport using its required injected user web connection', async () => {
      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({
          type: 'remote',
          kiloSessionId: kiloId('ses-1'),
        })
      );
      const release = jest.fn();
      const userWebConnection = {
        retain: jest.fn(() => jest.fn()),
        connect: jest.fn(),
        disconnect: jest.fn(),
        destroy: jest.fn(),
        isConnected: jest.fn(() => false),
        onConnectionChange: jest.fn(() => jest.fn()),
        isReconnectExhausted: jest.fn(() => false),
        onReconnectExhaustionChange: jest.fn(() => jest.fn()),
        retryConnection: jest.fn(),
        subscribeToCliSession: jest.fn(() => release),
        sendCommand: jest.fn(() => Promise.resolve()),
        sendCommandToConnection: jest.fn(() => Promise.resolve()),
        onCliEvent: jest.fn(() => jest.fn()),
        onSystemEvent: jest.fn(() => jest.fn()),
        onReconnect: jest.fn(() => jest.fn()),
        onSessionEvent: jest.fn(() => jest.fn()),
      };

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: { userWebConnection },
      });

      session.connect();
      await Promise.resolve();

      expect(userWebConnection.subscribeToCliSession).toHaveBeenCalledWith('ses-1');
      expect(webSocketConstructor).not.toHaveBeenCalled();

      session.destroy();
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveSession returning read-only session', () => {
    it('replays snapshot events', async () => {
      const snapshot = makeSnapshot({ id: SES_ID }, [
        {
          info: stubUserMessage({ id: 'msg-1', sessionID: SES_ID }),
          parts: [
            stubTextPart({ id: 'part-1', messageID: 'msg-1', sessionID: SES_ID, text: 'hi' }),
          ],
        },
      ]);

      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({
          type: 'read-only',
          kiloSessionId: kiloId('ses-1'),
        })
      );

      const fetchSnapshot = jest.fn(() => Promise.resolve(snapshot));

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {
          fetchSnapshot,
        },
      });

      session.connect();
      await Promise.resolve();
      await Promise.resolve();

      expect(session.state.getSessionInfo()).toEqual({ id: 'ses-1', parentID: undefined });

      const messageIds = session.storage.getMessageIds();
      expect(messageIds).toContain('msg-1');

      expect(session.canSend).toBe(false);
      expect(session.canInterrupt).toBe(false);

      session.destroy();
    });
  });

  describe('read-only session upgrade', () => {
    function makeFakeUserWebConnection() {
      const systemListeners = new Set<(event: { event: string; data: unknown }) => void>();
      const releaseRetain = jest.fn();
      const offSystemEvent = jest.fn();
      const subscribeRelease = jest.fn();
      return {
        connection: {
          retain: jest.fn(() => releaseRetain),
          connect: jest.fn(),
          disconnect: jest.fn(),
          destroy: jest.fn(),
          isConnected: jest.fn(() => false),
          onConnectionChange: jest.fn(() => jest.fn()),
          isReconnectExhausted: jest.fn(() => false),
          onReconnectExhaustionChange: jest.fn(() => jest.fn()),
          retryConnection: jest.fn(),
          subscribeToCliSession: jest.fn(() => subscribeRelease),
          sendCommand: jest.fn(() => Promise.resolve()),
          sendCommandToConnection: jest.fn(() => Promise.resolve()),
          onCliEvent: jest.fn(() => jest.fn()),
          onSystemEvent: jest.fn((listener: (event: { event: string; data: unknown }) => void) => {
            systemListeners.add(listener);
            return () => {
              offSystemEvent();
              systemListeners.delete(listener);
            };
          }),
          onReconnect: jest.fn(() => jest.fn()),
          onSessionEvent: jest.fn(() => jest.fn()),
        },
        emitSystemEvent(event: string, data: unknown) {
          for (const listener of systemListeners) listener({ event, data });
        },
        releaseRetain,
        offSystemEvent,
        subscribeRelease,
      };
    }

    it('re-resolves to remote when a CLI heartbeat reports the session as active', async () => {
      const snapshot = makeSnapshot({ id: SES_ID }, [
        {
          info: stubUserMessage({ id: 'msg-1', sessionID: SES_ID }),
          parts: [
            stubTextPart({ id: 'part-1', messageID: 'msg-1', sessionID: SES_ID, text: 'hi' }),
          ],
        },
      ]);

      const resolveSession = jest
        .fn<Promise<ResolvedSession>, [unknown]>()
        .mockResolvedValueOnce({ type: 'read-only', kiloSessionId: kiloId(SES_ID) })
        .mockResolvedValue({ type: 'remote', kiloSessionId: kiloId(SES_ID) });

      const fake = makeFakeUserWebConnection();

      const session = createCloudAgentSession({
        kiloSessionId: kiloId(SES_ID),
        resolveSession,
        transport: {
          fetchSnapshot: jest.fn(() => Promise.resolve(snapshot)),
          userWebConnection: fake.connection,
        },
      });

      session.connect();
      await Promise.resolve(); // resolveSession resolves
      await Promise.resolve(); // fetchSnapshot resolves

      expect(resolveSession).toHaveBeenCalledTimes(1);
      // The watcher subscribes (not just retains) so the server pushes
      // heartbeats/list re-sends for the watched session to this socket.
      expect(fake.connection.subscribeToCliSession).toHaveBeenCalledTimes(1);
      expect(fake.connection.subscribeToCliSession).toHaveBeenCalledWith(SES_ID);
      expect(fake.connection.retain).not.toHaveBeenCalled();
      expect(session.storage.getMessageIds()).toContain('msg-1');

      // A heartbeat for a different session must not trigger a re-resolve.
      fake.emitSystemEvent('sessions.heartbeat', {
        connectionId: 'conn-1',
        sessions: [{ id: 'ses-other', status: 'busy', title: 'Other' }],
      });
      expect(resolveSession).toHaveBeenCalledTimes(1);

      fake.emitSystemEvent('sessions.heartbeat', {
        connectionId: 'conn-1',
        sessions: [{ id: SES_ID, status: 'busy', title: 'Review' }],
      });
      await Promise.resolve(); // second resolveSession resolves

      expect(resolveSession).toHaveBeenCalledTimes(2);
      // Watcher is disarmed once the upgrade kicks off: its listener and
      // subscription are both released.
      expect(fake.offSystemEvent).toHaveBeenCalledTimes(1);
      expect(fake.subscribeRelease).toHaveBeenCalledTimes(1);

      session.destroy();
    });

    it('disarms the watcher on destroy without re-resolving', async () => {
      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({ type: 'read-only', kiloSessionId: kiloId(SES_ID) })
      );

      const fake = makeFakeUserWebConnection();

      const session = createCloudAgentSession({
        kiloSessionId: kiloId(SES_ID),
        resolveSession,
        transport: {
          fetchSnapshot: jest.fn(() => Promise.resolve(makeSnapshot({ id: SES_ID }, []))),
          userWebConnection: fake.connection,
        },
      });

      session.connect();
      await Promise.resolve();
      await Promise.resolve();

      session.destroy();
      expect(fake.offSystemEvent).toHaveBeenCalledTimes(1);
      expect(fake.subscribeRelease).toHaveBeenCalledTimes(1);

      fake.emitSystemEvent('sessions.heartbeat', {
        connectionId: 'conn-1',
        sessions: [{ id: SES_ID, status: 'busy', title: 'Review' }],
      });
      expect(resolveSession).toHaveBeenCalledTimes(1);
    });

    describe('with fake timers', () => {
      // The historical transport has no internal timers, so fake timers only
      // exercise the re-arm cool-down the watcher schedules after a
      // stay-read-only re-resolve.
      beforeEach(() => {
        jest.useFakeTimers();
      });
      afterEach(() => {
        jest.useRealTimers();
      });

      // The rearm path holds microtask+setTimeout flush semantics only — no
      // real time is needed beyond jest's fake clock.
      async function flushUpgradeResolution(): Promise<void> {
        for (let i = 0; i < 10; i++) {
          await Promise.resolve();
        }
      }

      function heartbeatPayload(status: string) {
        return {
          connectionId: 'conn-1',
          sessions: [{ id: SES_ID, status, title: 'Review' }],
        };
      }

      it('keeps the historical transport when repeated heartbeats still resolve read-only', async () => {
        const resolveSession = jest.fn((): Promise<ResolvedSession> =>
          Promise.resolve({ type: 'read-only', kiloSessionId: kiloId(SES_ID) })
        );
        const fetchSnapshot = jest.fn(() =>
          Promise.resolve(makeSnapshot({ id: SES_ID }, []))
        );
        const fake = makeFakeUserWebConnection();

        const session = createCloudAgentSession({
          kiloSessionId: kiloId(SES_ID),
          resolveSession,
          transport: {
            fetchSnapshot,
            userWebConnection: fake.connection,
          },
        });

        session.connect();
        await flushUpgradeResolution();

        // Initial open: one resolve, one watcher arm.
        expect(resolveSession).toHaveBeenCalledTimes(1);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        expect(fake.connection.subscribeToCliSession).toHaveBeenCalledTimes(1);

        fake.emitSystemEvent('sessions.heartbeat', heartbeatPayload('busy'));
        await flushUpgradeResolution();

        // Same-row re-resolve that stays read-only keeps the historical
        // transport: no second fetch, and the watcher re-arms only after the
        // 1s cool-down.
        expect(resolveSession).toHaveBeenCalledTimes(2);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        expect(fake.connection.subscribeToCliSession).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1000);
        expect(fake.connection.subscribeToCliSession).toHaveBeenCalledTimes(2);

        // Heartbeats 2..5 repeat the row the watcher already accepted as
        // evidence; the identical-row gate must turn each one into a no-op —
        // no re-resolve, no refetch, no extra re-arm.
        for (let i = 0; i < 5; i++) {
          fake.emitSystemEvent('sessions.heartbeat', heartbeatPayload('busy'));
          await flushUpgradeResolution();
        }
        expect(resolveSession).toHaveBeenCalledTimes(2);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        expect(fake.connection.subscribeToCliSession).toHaveBeenCalledTimes(2);
        expect(fake.subscribeRelease).toHaveBeenCalledTimes(1);
        expect(fake.offSystemEvent).toHaveBeenCalledTimes(1);

        // A pending cool-down must not outlive destroy: no re-arm, no extra
        // resolve after the timer would have fired.
        session.destroy();
        jest.advanceTimersByTime(1000);
        expect(resolveSession).toHaveBeenCalledTimes(2);
        expect(fake.connection.subscribeToCliSession).toHaveBeenCalledTimes(2);
      });

      it('re-arms the watcher after the cool-down and upgrades when status changes', async () => {
        const resolveSession = jest
          .fn<Promise<ResolvedSession>, [unknown]>()
          .mockResolvedValueOnce({ type: 'read-only', kiloSessionId: kiloId(SES_ID) })
          .mockResolvedValueOnce({ type: 'read-only', kiloSessionId: kiloId(SES_ID) })
          .mockResolvedValue({ type: 'remote', kiloSessionId: kiloId(SES_ID) });
        const fetchSnapshot = jest.fn(() =>
          Promise.resolve(makeSnapshot({ id: SES_ID }, []))
        );
        const fake = makeFakeUserWebConnection();

        const remoteApi = {
          send: jest.fn(() => Promise.resolve()),
          interrupt: jest.fn(() => Promise.resolve()),
          answer: jest.fn(() => Promise.resolve()),
          reject: jest.fn(() => Promise.resolve()),
          respondToPermission: jest.fn(() => Promise.resolve()),
        };

        const session = createCloudAgentSession({
          kiloSessionId: kiloId(SES_ID),
          resolveSession,
          transport: {
            fetchSnapshot,
            userWebConnection: fake.connection,
            api: remoteApi,
          },
        });

        session.connect();
        await flushUpgradeResolution();

        // First heartbeat reaches the still-CLI session: one stay-read-only
        // re-resolve while the transport stays historical.
        fake.emitSystemEvent('sessions.heartbeat', heartbeatPayload('busy'));
        await flushUpgradeResolution();
        expect(resolveSession).toHaveBeenCalledTimes(2);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);

        // After the cool-down the watcher re-arms; the changed row then
        // drives a second re-resolve that comes back remote, so the session
        // upgrades off the historical transport.
        jest.advanceTimersByTime(1000);
        expect(fake.connection.subscribeToCliSession).toHaveBeenCalledTimes(2);

        fake.emitSystemEvent('sessions.heartbeat', heartbeatPayload('idle'));
        await flushUpgradeResolution();
        expect(resolveSession).toHaveBeenCalledTimes(3);
        // The transport was rebuilt on the remote resolution: the historical
        // transport seeded once at open, and the live CLI transport seeds its
        // own replay with the same fetchSnapshot config on attach.
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        expect(remoteApi.send).not.toHaveBeenCalled();
        // The upgraded watcher life released the earlier one: one extra
        // disarm pair on top of the initial teardown at the upgrade trigger.
        expect(fake.offSystemEvent).toHaveBeenCalledTimes(2);
        expect(fake.subscribeRelease).toHaveBeenCalledTimes(2);
        expect(fake.connection.subscribeToCliSession).toHaveBeenCalledTimes(3);

        session.destroy();
      });

      it('ignores heartbeats whose row is unchanged after an upgrade attempt', async () => {
        const resolveSession = jest.fn((): Promise<ResolvedSession> =>
          Promise.resolve({ type: 'read-only', kiloSessionId: kiloId(SES_ID) })
        );
        const fetchSnapshot = jest.fn(() =>
          Promise.resolve(makeSnapshot({ id: SES_ID }, []))
        );
        const fake = makeFakeUserWebConnection();

        const session = createCloudAgentSession({
          kiloSessionId: kiloId(SES_ID),
          resolveSession,
          transport: {
            fetchSnapshot,
            userWebConnection: fake.connection,
          },
        });

        session.connect();
        await flushUpgradeResolution();

        // First heartbeat is new evidence: one re-resolve that stays
        // read-only.
        fake.emitSystemEvent('sessions.heartbeat', heartbeatPayload('busy'));
        await flushUpgradeResolution();
        expect(resolveSession).toHaveBeenCalledTimes(2);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);

        // Two more identical heartbeats carry no new evidence: no extra
        // re-resolve, no extra refetch while the cool-down is pending.
        fake.emitSystemEvent('sessions.heartbeat', heartbeatPayload('busy'));
        await flushUpgradeResolution();
        fake.emitSystemEvent('sessions.heartbeat', heartbeatPayload('busy'));
        await flushUpgradeResolution();

        expect(resolveSession).toHaveBeenCalledTimes(2);
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);

        session.destroy();
      });
    });
  });

  // NOTE: The old "completed Cloud Agent session" case (cloudAgentSessionId present
  // but isLive=false) no longer exists. With the discriminated union, the resolver
  // decides the session type. A completed cloud agent session is resolved as
  // 'cloud-agent' (the transport handles completion via snapshot + WebSocket), or
  // the resolver may choose 'read-only' for sessions without a live DO.

  describe('resolveSession failure', () => {
    it('sets error state and fires onError', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.reject(new Error('Session not found'))
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {},
        onError,
      });

      const states = captureStates(session);

      session.connect();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith('Session not found');

      const errorState = states.find(s => s.status.type === 'error');
      expect(errorState).toBeDefined();
      expect(errorState!.activity).toEqual({ type: 'idle' });
      expect(errorState!.status).toEqual({ type: 'error', message: 'Session not found' });

      session.destroy();
    });

    it('uses generic message for non-Error throws', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.reject('plain string error')
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {},
        onError,
      });

      session.connect();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith('Failed to resolve session');

      session.destroy();
    });
  });

  describe('transport config validation', () => {
    it('sets error state when Cloud Agent session lacks getTicket', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({
          type: 'cloud-agent',
          kiloSessionId: kiloId('ses-1'),
          cloudAgentSessionId: cloudAgentId('do-1'),
        })
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {},
        onError,
      });

      session.connect();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(
        'CloudAgentSession transport.getTicket is required for Cloud Agent sessions'
      );
      expect(session.state.getActivity()).toEqual({ type: 'idle' });
      expect(session.state.getStatus()).toEqual({
        type: 'error',
        message: 'CloudAgentSession transport.getTicket is required for Cloud Agent sessions',
      });

      session.destroy();
    });

    it('sets error state when Cloud Agent session lacks fetchSnapshot', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({
          type: 'cloud-agent',
          kiloSessionId: kiloId('ses-1'),
          cloudAgentSessionId: cloudAgentId('do-1'),
        })
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: { getTicket: () => 'ticket' },
        onError,
      });

      session.connect();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(
        'CloudAgentSession transport.fetchSnapshot is required for Cloud Agent sessions'
      );
      expect(session.state.getActivity()).toEqual({ type: 'idle' });
      expect(session.state.getStatus().type).toBe('error');

      session.destroy();
    });

    it('sets error state when Cloud Agent session lacks api', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({
          type: 'cloud-agent',
          kiloSessionId: kiloId('ses-1'),
          cloudAgentSessionId: cloudAgentId('do-1'),
        })
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {
          getTicket: () => 'ticket',
          fetchSnapshot: () => Promise.resolve(makeSnapshot({ id: 'ses-1' })),
        },
        onError,
      });

      session.connect();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(
        'CloudAgentSession transport.api is required for Cloud Agent sessions'
      );
      expect(session.state.getActivity()).toEqual({ type: 'idle' });
      expect(session.state.getStatus().type).toBe('error');

      session.destroy();
    });

    it('sets error state when remote session lacks required config', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({
          type: 'remote',
          kiloSessionId: kiloId('ses-1'),
        })
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {},
        onError,
      });

      session.connect();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(
        'CloudAgentSession transport.userWebConnection is required for remote CLI sessions'
      );
      expect(session.state.getActivity()).toEqual({ type: 'idle' });
      expect(session.state.getStatus().type).toBe('error');

      session.destroy();
    });

    it('sets error state when read-only session lacks fetchSnapshot', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn((): Promise<ResolvedSession> =>
        Promise.resolve({
          type: 'read-only',
          kiloSessionId: kiloId('ses-1'),
        })
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {},
        onError,
      });

      session.connect();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(
        'CloudAgentSession transport.fetchSnapshot is required for read-only sessions'
      );
      expect(session.state.getActivity()).toEqual({ type: 'idle' });
      expect(session.state.getStatus().type).toBe('error');

      session.destroy();
    });
  });
});
