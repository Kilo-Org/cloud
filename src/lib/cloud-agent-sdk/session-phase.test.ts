/**
 * Tests for the ServiceState transitions driven by createCloudAgentSession.
 *
 * Uses a WebSocket mock to feed events through the real session pipeline
 * and capture state changes via session.state.subscribe().
 */
import { createCloudAgentSession } from './session';
import { createEventHelpers, sessionInfo } from './__fixtures__/helpers';
import { kiloId, cloudAgentId, makeSnapshot } from './test-helpers';
import type { SessionActivity, AgentStatus, SessionInfo } from './types';
import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

type MockWebSocket = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: jest.Mock;
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
    readyState: 1,
  };

  webSocketConstructor = jest.fn(() => mockWs);

  // @ts-expect-error -- minimal WebSocket mock for testing
  global.WebSocket = webSocketConstructor;
});

afterEach(() => {
  // @ts-expect-error -- cleanup global mock
  delete global.WebSocket;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendRaw(event: CloudAgentEvent): void {
  mockWs.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
}

const emptySnapshot = makeSnapshot({ id: 'test-session' });

/** Drain the microtask queue so resolveSession, getTicket, and fetchSnapshot
 *  resolve, causing the WebSocket to be created and onmessage to be assigned. */
async function flushConnect(): Promise<void> {
  await Promise.resolve(); // resolveSession resolves
  await new Promise(r => setTimeout(r, 0)); // Promise.all([ticket, snapshot]).then settles
}

type StateCapture = { activity: SessionActivity; status: AgentStatus };

const TEST_KILO_ID = kiloId('test-session');
const TEST_CLOUD_AGENT_ID = cloudAgentId('test-session');

function createSessionWithStateCapture(
  getTicketMock: jest.Mock<string | Promise<string>, [string]> = jest.fn(
    (_sessionId: string) => 'test-ticket'
  )
) {
  const { createEvent, kilocode, resetCounter } = createEventHelpers();
  resetCounter();

  const errors: string[] = [];
  const branches: string[] = [];

  const session = createCloudAgentSession({
    kiloSessionId: TEST_KILO_ID,
    resolveSession: async () => ({
      type: 'cloud-agent' as const,
      kiloSessionId: TEST_KILO_ID,
      cloudAgentSessionId: TEST_CLOUD_AGENT_ID,
    }),
    websocketBaseUrl: 'ws://localhost:9999',
    transport: {
      getTicket: getTicketMock,
      fetchSnapshot: () => Promise.resolve(emptySnapshot),
      api: {
        send: () => Promise.resolve(),
        interrupt: () => Promise.resolve(),
        answer: () => Promise.resolve(),
        reject: () => Promise.resolve(),
        respondToPermission: () => Promise.resolve(),
      },
    },
    onError: (msg: string) => errors.push(msg),
    onBranchChanged: (branch: string) => branches.push(branch),
  });

  // Capture state changes
  const states: StateCapture[] = [];
  session.state.subscribe(() => {
    states.push({
      activity: structuredClone(session.state.getActivity()),
      status: structuredClone(session.state.getStatus()),
    });
  });

  return { session, states, errors, branches, createEvent, kilocode, getTicketMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session state transitions', () => {
  it('connect() emits connecting activity', () => {
    const { session, states } = createSessionWithStateCapture();

    session.connect();
    expect(states[0].activity).toEqual({ type: 'connecting' });

    session.destroy();
  });

  it('connect() fetches ticket with sessionId', async () => {
    const getTicketMock = jest.fn((_sessionId: string) => 'test-ticket');
    const { session } = createSessionWithStateCapture(getTicketMock);

    session.connect();
    await flushConnect();

    expect(getTicketMock).toHaveBeenCalledWith('test-session');
    session.destroy();
  });

  it('auth-close refresh reuses getTicket callback', async () => {
    const getTicketMock = jest
      .fn<Promise<string>, [string]>()
      .mockResolvedValueOnce('ticket-1')
      .mockResolvedValueOnce('ticket-2');

    const { session } = createSessionWithStateCapture(getTicketMock);

    session.connect();
    await flushConnect(); // resolveSession + getTicket resolves → WS created

    mockWs.onclose?.({ code: 1008, reason: 'unauthorized', wasClean: false } as CloseEvent);

    // refreshAuthAndReconnect: await refreshTicket() (1 tick for the resolved promise
    // wrapping getTicket), then connectInternal creates a new WebSocket
    await Promise.resolve(); // refreshAuth resolves
    await Promise.resolve(); // getTicket promise resolves inside refreshTicket

    expect(getTicketMock).toHaveBeenNthCalledWith(1, 'test-session');
    expect(getTicketMock).toHaveBeenNthCalledWith(2, 'test-session');
    expect(webSocketConstructor).toHaveBeenCalledTimes(2);
    session.destroy();
  });

  it('session.status busy transitions to busy activity', async () => {
    const { session, states, kilocode } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));

    // First state: connecting (from connect()), later states include busy + idle status
    expect(states[0].activity).toEqual({ type: 'connecting' });
    const busyState = states.find(s => s.activity.type === 'busy');
    expect(busyState?.activity).toEqual({ type: 'busy' });
    expect(busyState?.status).toEqual({ type: 'idle' });

    session.destroy();
  });

  it('session.status retry transitions to retrying activity', async () => {
    const { session, states, kilocode } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(
      kilocode('session.status', {
        sessionID: 'test-session',
        status: { type: 'retry', attempt: 2, message: 'rate limited', next: 5000 },
      })
    );

    const retryState = states.find(s => s.activity.type === 'retrying');
    expect(retryState?.activity).toEqual({
      type: 'retrying',
      attempt: 2,
      message: 'rate limited',
    });

    session.destroy();
  });

  it('stopped(complete) transitions to idle activity and fires onBranchChanged', async () => {
    const { session, states, branches, kilocode, createEvent } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(createEvent('complete', { currentBranch: 'main' }));

    // After complete: activity = idle, status = idle
    const lastState = states[states.length - 1];
    expect(lastState.activity).toEqual({ type: 'idle' });
    expect(lastState.status).toEqual({ type: 'idle' });
    expect(branches).toEqual(['main']);

    session.destroy();
  });

  it('stopped(interrupted) transitions to idle activity with interrupted status', async () => {
    const { session, states, kilocode, createEvent } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(createEvent('interrupted', {}));

    const lastState = states[states.length - 1];
    expect(lastState.activity).toEqual({ type: 'idle' });
    expect(lastState.status).toEqual({ type: 'interrupted' });

    session.destroy();
  });

  it('stopped(error) transitions to idle activity with error status and fires onError', async () => {
    const { session, states, errors, kilocode, createEvent } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(createEvent('error', { fatal: true }));

    const lastState = states[states.length - 1];
    expect(lastState.activity).toEqual({ type: 'idle' });
    expect(lastState.status).toEqual({ type: 'error', message: 'Session terminated' });
    expect(errors).toContain('Session terminated');

    session.destroy();
  });

  it('stopped(disconnected) transitions to idle activity with disconnected status and fires onError', async () => {
    const { session, states, errors, kilocode, createEvent } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(createEvent('wrapper_disconnected', {}));

    const lastState = states[states.length - 1];
    expect(lastState.activity).toEqual({ type: 'idle' });
    expect(lastState.status).toEqual({ type: 'disconnected' });
    expect(errors).toContain('Connection to agent lost');

    session.destroy();
  });

  it('unexpected websocket close transitions to idle activity with disconnected status', async () => {
    const { session, states, errors, kilocode } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));

    mockWs.onclose?.({ code: 1011, reason: 'network dropped', wasClean: false } as CloseEvent);

    const lastState = states[states.length - 1];
    const errorMessages = [...errors];
    session.destroy();

    expect(lastState.activity).toEqual({ type: 'idle' });
    expect(lastState.status).toEqual({ type: 'disconnected' });
    expect(errorMessages).toContain('Connection to agent lost');
  });

  it('session.error is suppressed after stopped', async () => {
    const { session, errors, kilocode, createEvent } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(createEvent('interrupted', {}));

    // Clear errors accumulated from the stopped transition
    errors.length = 0;

    sendRaw(kilocode('session.error', { error: 'aftershock error', sessionID: 'test-session' }));
    expect(errors).toEqual([]);

    session.destroy();
  });

  it('session.error fires onError before stopped', async () => {
    const { session, errors, kilocode } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(kilocode('session.error', { error: 'real error', sessionID: 'test-session' }));

    expect(errors).toContain('real error');

    session.destroy();
  });

  it('session.status idle transitions root session from busy to idle', async () => {
    const { session, states, kilocode } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'idle' } }));

    // Root session idle status transitions activity from busy → idle
    const lastState = states[states.length - 1];
    expect(lastState.activity).toEqual({ type: 'idle' });

    session.destroy();
  });

  it('new busy after complete resets activity to busy', async () => {
    const { session, states, kilocode, createEvent } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(createEvent('complete', {}));
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));

    const activities = states.map(s => s.activity);
    expect(activities).toContainEqual({ type: 'busy' });

    // The last state should be busy again
    const lastState = states[states.length - 1];
    expect(lastState.activity).toEqual({ type: 'busy' });

    session.destroy();
  });

  it('session.error allowed again after new busy following stopped', async () => {
    const { session, errors, kilocode, createEvent } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(createEvent('interrupted', {}));
    errors.length = 0;

    // New turn starts — resets from stopped
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(kilocode('session.error', { error: 'new error', sessionID: 'test-session' }));

    expect(errors).toContain('new error');

    session.destroy();
  });

  it('session.created fires onSessionCreated', async () => {
    const { createEvent: _createEvent, kilocode, resetCounter } = createEventHelpers();
    resetCounter();

    const sessions: unknown[] = [];
    const getTicketMock = jest.fn((_sessionId: string) => 'test-ticket');
    const session = createCloudAgentSession({
      kiloSessionId: TEST_KILO_ID,
      resolveSession: async () => ({
        type: 'cloud-agent' as const,
        kiloSessionId: TEST_KILO_ID,
        cloudAgentSessionId: TEST_CLOUD_AGENT_ID,
      }),
      websocketBaseUrl: 'ws://localhost:9999',
      transport: {
        getTicket: getTicketMock,
        fetchSnapshot: () => Promise.resolve(emptySnapshot),
        api: {
          send: () => Promise.resolve(),
          interrupt: () => Promise.resolve(),
          answer: () => Promise.resolve(),
          reject: () => Promise.resolve(),
          respondToPermission: () => Promise.resolve(),
        },
      },
      onSessionCreated: (info: SessionInfo) => sessions.push(info),
    });

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.created', { info: sessionInfo('ses-1') }));

    // Snapshot replay fires session.created for 'test-session', then WS event fires for 'ses-1'
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toEqual(expect.objectContaining({ id: 'ses-1' }));

    session.destroy();
  });

  it('stopped(complete) without branch does not fire onBranchChanged', async () => {
    const { session, branches, kilocode, createEvent } = createSessionWithStateCapture();

    session.connect();
    await flushConnect();
    sendRaw(kilocode('session.status', { sessionID: 'test-session', status: { type: 'busy' } }));
    sendRaw(createEvent('complete', {}));

    expect(branches).toEqual([]);

    session.destroy();
  });
});
