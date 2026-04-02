/**
 * Tests for session transport routing — verifies that resolveSession
 * correctly routes to Cloud Agent, CLI live, or CLI historical transports.
 */
import { createCloudAgentSession } from './session';
import type { ResolvedSession } from './types';
import type { SessionActivity, AgentStatus } from './types';
import { kiloId, cloudAgentId, makeSnapshot, stubUserMessage, stubTextPart } from './test-helpers';

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session transport routing', () => {
  describe('resolveSession returning Cloud Agent session', () => {
    it('creates Cloud Agent transport with resolved cloudAgentSessionId', async () => {
      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> =>
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
    it('creates CLI live transport and sends subscribe message', async () => {
      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> =>
          Promise.resolve({
            type: 'remote',
            kiloSessionId: kiloId('ses-1'),
          })
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {
          getAuthToken: () => 'auth-token',
          cliWebsocketUrl: 'wss://localhost:8888/api/user/web',
        },
      });

      session.connect();
      await Promise.resolve();

      // CLI live transport connects to the cliWebsocketUrl with auth token
      expect(webSocketConstructor).toHaveBeenCalledTimes(1);
      const url = webSocketConstructor.mock.calls[0][0] as string;
      expect(url).toContain('localhost:8888');

      // Opening the connection sends a subscribe message
      mockWs.onopen?.({} as Event);
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
      );

      session.destroy();
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

      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> =>
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
      // resolveSession resolves
      await Promise.resolve();
      // fetchSnapshot resolves
      await Promise.resolve();

      // Session info set from snapshot
      expect(session.state.getSessionInfo()).toEqual({ id: 'ses-1', parentID: undefined });

      // Messages in storage
      const messageIds = session.storage.getMessageIds();
      expect(messageIds).toContain('msg-1');

      // Historical session should not be interactive
      expect(session.canSend).toBe(false);
      expect(session.canInterrupt).toBe(false);

      session.destroy();
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

      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> => Promise.reject(new Error('Session not found'))
      );

      const session = createCloudAgentSession({
        kiloSessionId: kiloId('ses-1'),
        resolveSession,
        transport: {},
        onError,
      });

      const states = captureStates(session);

      session.connect();
      // resolveSession rejects
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith('Session not found');

      // Should have connecting → idle+error
      const errorState = states.find(s => s.status.type === 'error');
      expect(errorState).toBeDefined();
      expect(errorState!.activity).toEqual({ type: 'idle' });
      expect(errorState!.status).toEqual({ type: 'error', message: 'Session not found' });

      session.destroy();
    });

    it('uses generic message for non-Error throws', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> => Promise.reject('plain string error')
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

      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> =>
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

      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> =>
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

      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> =>
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

      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> =>
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
        'CloudAgentSession transport.cliWebsocketUrl and getAuthToken are required for remote CLI sessions'
      );
      expect(session.state.getActivity()).toEqual({ type: 'idle' });
      expect(session.state.getStatus().type).toBe('error');

      session.destroy();
    });

    it('sets error state when read-only session lacks fetchSnapshot', async () => {
      const onError = jest.fn();

      const resolveSession = jest.fn(
        (): Promise<ResolvedSession> =>
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
