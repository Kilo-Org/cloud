/**
 * Tests for the ServiceState transitions driven by createCloudAgentSession.
 *
 * Uses a WebSocket mock to feed events through the real session pipeline
 * and capture state changes via session.state.subscribe().
 */
import { createStore } from 'jotai';
import { createCloudAgentSession } from './session';
import { createSessionManager, type SessionManagerConfig } from './session-manager';
import type { CloudAgentApi } from './transport';
import {
  createEventHelpers,
  sessionInfo,
  userMsg,
  assistantMsg,
  textPart,
} from './__fixtures__/helpers';
import { kiloId, cloudAgentId, makeSnapshot } from './test-helpers';
import type { SessionActivity, AgentStatus, SessionInfo } from './types';
import type { CloudAgentEvent } from './event-types';

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
  const { createEvent, kilocode, resetCounter } = createEventHelpers(TEST_CLOUD_AGENT_ID);
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
    const {
      createEvent: _createEvent,
      kilocode,
      resetCounter,
    } = createEventHelpers(TEST_CLOUD_AGENT_ID);
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

describe('authoritative message failure settlement', () => {
  function createManager() {
    const store = createStore();
    const sent: Parameters<CloudAgentApi['send']>[0][] = [];
    const manager = createSessionManager({
      store,
      userWebConnection: {} as SessionManagerConfig['userWebConnection'],
      resolveSession: async () => ({
        type: 'cloud-agent',
        kiloSessionId: TEST_KILO_ID,
        cloudAgentSessionId: TEST_CLOUD_AGENT_ID,
      }),
      websocketBaseUrl: 'ws://localhost:9999',
      getTicket: () => 'test-ticket',
      fetchSnapshot: async () => emptySnapshot,
      api: {
        send: async input => {
          sent.push(input);
        },
        interrupt: async () => undefined,
        answer: async () => undefined,
        reject: async () => undefined,
        respondToPermission: async () => undefined,
      },
      prepare: async () => ({
        cloudAgentSessionId: TEST_CLOUD_AGENT_ID,
        kiloSessionId: TEST_KILO_ID,
      }),
      initiate: async () => undefined,
      fetchSession: async () => ({
        kiloSessionId: TEST_KILO_ID,
        cloudAgentSessionId: TEST_CLOUD_AGENT_ID,
        title: 'Existing chat',
        organizationId: null,
        gitUrl: null,
        gitBranch: 'main',
        mode: 'code',
        model: 'kilo/fake-deterministic',
        variant: null,
        repository: 'test/repo',
        isInitiated: true,
        needsLegacyPrepare: false,
        isPreparingAsync: false,
        prompt: null,
        initialMessageId: null,
        associatedPr: null,
      }),
    });
    const snapshot = () => ({
      activity: store.get(manager.atoms.activity),
      agentStatus: store.get(manager.atoms.agentStatus),
      cloudStatus: store.get(manager.atoms.cloudStatus),
      isStreaming: store.get(manager.atoms.isStreaming),
      canSend: store.get(manager.atoms.canSend),
      question: store.get(manager.atoms.question),
      activeQuestion: store.get(manager.atoms.activeQuestion),
      pendingQuestions: store.get(manager.atoms.pendingQuestions),
      permission: store.get(manager.atoms.permission),
      activePermission: store.get(manager.atoms.activePermission),
      pendingPermissions: store.get(manager.atoms.pendingPermissions),
      suggestion: store.get(manager.atoms.suggestion),
      activeSuggestion: store.get(manager.atoms.activeSuggestion),
    });
    const events = createEventHelpers(TEST_CLOUD_AGENT_ID);
    const requestInput = () => {
      for (const sessionID of [TEST_KILO_ID, 'child-session']) {
        sendRaw(
          events.kilocode('question.asked', {
            id: `question-${sessionID}`,
            sessionID,
            questions: [{ question: 'Continue?', header: 'Approval', options: [] }],
          })
        );
        sendRaw(
          events.kilocode('permission.asked', {
            id: `permission-${sessionID}`,
            sessionID,
            permission: 'edit',
            patterns: ['file.txt'],
            metadata: {},
            always: [],
          })
        );
      }
    };
    return { manager, store, sent, snapshot, requestInput, ...events };
  }

  it.each([
    {
      name: 'queued interruption',
      messageId: 'queued',
      failure: {
        delivery: 'queued',
        accepted: false,
        reason: 'interrupted',
        status: 'interrupted',
      },
    },
    {
      name: 'queued exhaustion',
      messageId: 'queued',
      failure: { delivery: 'queued', accepted: false, attempts: 5, status: 'failed' },
    },
    {
      name: 'unrelated accepted failure',
      messageId: 'unrelated',
      failure: {
        delivery: 'sent',
        accepted: true,
        reason: 'wrapper_disconnected',
        status: 'failed',
      },
    },
    {
      name: 'stale accepted interruption',
      messageId: 'old',
      failure: { delivery: 'sent', accepted: true, reason: 'interrupted', status: 'interrupted' },
    },
    {
      name: 'stale queued-only failure for the same message',
      messageId: 'active',
      failure: { delivery: 'queued', reason: 'interrupted', status: 'interrupted' },
    },
    {
      name: 'explicitly unaccepted failure for the same message',
      messageId: 'active',
      failure: { accepted: false, status: 'failed' },
    },
  ])('does not clobber the active turn on $name', async ({ messageId, failure }) => {
    const { manager, store, snapshot, requestInput, createEvent, kilocode } = createManager();
    try {
      await manager.switchSession(TEST_KILO_ID);
      await flushConnect();
      sendRaw(createEvent('connected', { cloudStatus: { type: 'ready' } }));
      sendRaw(
        createEvent('cloud.message.sent', { messageId: 'old', executionId: 'shared-execution' })
      );
      sendRaw(
        createEvent('cloud.message.completed', {
          messageId: 'old',
          executionId: 'shared-execution',
        })
      );
      sendRaw(
        createEvent('cloud.message.sent', { messageId: 'active', executionId: 'shared-execution' })
      );
      sendRaw(kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } }));
      sendRaw(createEvent('cloud.message.queued', { messageId: 'queued', content: 'Later' }));
      requestInput();
      const before = snapshot();
      expect(before.isStreaming).toBe(true);
      expect(before.pendingQuestions).toHaveLength(2);
      expect(before.pendingPermissions).toHaveLength(2);

      sendRaw(
        createEvent('cloud.message.failed', {
          messageId,
          executionId: 'shared-execution',
          error: 'Message failed',
          ...failure,
        })
      );

      expect(snapshot()).toEqual(before);
      expect(store.get(manager.atoms.pendingMessages).get(messageId)?.status).toBe('failed');
      expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  it.each([
    {
      name: 'Cloudflare accepted failure',
      failure: {
        status: 'failed',
        delivery: 'sent',
        accepted: true,
        reason: 'control_disconnected',
      },
      expectedStatus: { type: 'error', message: 'Message delivery failed' },
      expectedReason: 'execution',
    },
    {
      name: 'Cloudflare accepted interruption',
      failure: {
        status: 'interrupted',
        delivery: 'sent',
        accepted: true,
        reason: 'interrupted',
        error: 'The message was interrupted',
      },
      expectedStatus: { type: 'interrupted' },
      expectedReason: 'interrupted',
    },
    {
      name: 'Vercel accepted failure',
      failure: {
        executionId: 'compat-execution',
        status: 'failed',
        delivery: 'sent',
        accepted: true,
        reason: 'wrapper_disconnected',
        error: 'The message failed',
      },
      expectedStatus: { type: 'error', message: 'The message failed' },
      expectedReason: 'execution',
    },
    {
      name: 'Vercel accepted interruption',
      failure: {
        executionId: 'compat-execution',
        status: 'interrupted',
        delivery: 'sent',
        accepted: true,
        reason: 'interrupted',
        error: 'The message was interrupted',
      },
      expectedStatus: { type: 'interrupted' },
      expectedReason: 'interrupted',
    },
  ])(
    'clears turn-owned interactions on $name',
    async ({ failure, expectedStatus, expectedReason }) => {
      const { manager, store, snapshot, requestInput, createEvent, kilocode } = createManager();
      try {
        await manager.switchSession(TEST_KILO_ID);
        await flushConnect();
        sendRaw(createEvent('connected', { cloudStatus: { type: 'ready' } }));
        sendRaw(
          createEvent('cloud.message.sent', {
            messageId: 'active',
            executionId: 'compat-execution',
          })
        );
        sendRaw(kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } }));
        sendRaw(createEvent('cloud.message.queued', { messageId: 'next', content: 'Next turn' }));
        requestInput();
        expect(snapshot().pendingQuestions).toHaveLength(2);
        expect(snapshot().pendingPermissions).toHaveLength(2);

        sendRaw(createEvent('cloud.message.failed', { messageId: 'active', ...failure }));

        expect(snapshot()).toMatchObject({
          activity: { type: 'idle' },
          agentStatus: expectedStatus,
          isStreaming: false,
          canSend: true,
          question: null,
          activeQuestion: null,
          pendingQuestions: [],
          permission: null,
          activePermission: null,
          pendingPermissions: [],
        });
        expect(store.get(manager.atoms.pendingMessages).get('active')).toMatchObject({
          status: 'failed',
          reason: expectedReason,
        });
        expect(store.get(manager.atoms.pendingMessages).get('next')).toEqual({ status: 'queued' });
        expect(webSocketConstructor).toHaveBeenCalledTimes(1);
        const terminalSnapshot = snapshot();
        sendRaw(kilocode('session.error', { sessionID: TEST_KILO_ID, error: 'Late error' }));
        expect(snapshot()).toEqual(terminalSnapshot);
      } finally {
        manager.destroy();
      }
    }
  );

  it.each(['preparing', 'finalizing'])(
    'releases stale %s status when the active turn fails',
    async type => {
      const { manager, snapshot, createEvent, kilocode } = createManager();
      try {
        await manager.switchSession(TEST_KILO_ID);
        await flushConnect();
        sendRaw(createEvent('cloud.message.sent', { messageId: 'active' }));
        sendRaw(kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } }));
        sendRaw(createEvent('cloud.status', { cloudStatus: { type } }));
        expect(snapshot().canSend).toBe(false);

        sendRaw(
          createEvent('cloud.message.failed', {
            messageId: 'active',
            accepted: true,
            delivery: 'sent',
            reason: 'control_disconnected',
          })
        );

        expect(snapshot()).toMatchObject({
          activity: { type: 'idle' },
          agentStatus: { type: 'error', message: 'Message delivery failed' },
          cloudStatus: null,
          isStreaming: false,
          canSend: true,
        });
        expect(webSocketConstructor).toHaveBeenCalledTimes(1);
      } finally {
        manager.destroy();
      }
    }
  );

  it.each(['fresh viewer', 'reconnecting viewer', 'viewer replaying a historical failure'])(
    'hydrates the active identity from connected for a %s before sent replay',
    async viewer => {
      const { manager, store, snapshot, requestInput, createEvent, kilocode } = createManager();
      try {
        await manager.switchSession(TEST_KILO_ID);
        await flushConnect();
        if (viewer !== 'fresh viewer') {
          sendRaw(createEvent('cloud.message.sent', { messageId: 'old' }));
          sendRaw(
            kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } })
          );
        }
        if (viewer === 'viewer replaying a historical failure') {
          sendRaw(
            createEvent('cloud.message.failed', {
              messageId: 'old',
              accepted: true,
              delivery: 'sent',
              error: 'Historical failure',
            })
          );
          expect(store.get(manager.atoms.pendingMessages).get('old')?.status).toBe('failed');
        }
        sendRaw(
          createEvent('connected', {
            activeMessageId: 'current',
            sessionStatus: { type: 'busy' },
            cloudStatus: { type: 'ready' },
          })
        );
        requestInput();
        const before = snapshot();
        expect(before).toMatchObject({ isStreaming: true, agentStatus: { type: 'idle' } });
        expect(store.get(manager.atoms.statusIndicator)).toBeNull();
        sendRaw(
          createEvent('cloud.message.failed', {
            messageId: 'old',
            accepted: true,
            delivery: 'sent',
            reason: 'interrupted',
          })
        );
        expect(snapshot()).toEqual(before);

        sendRaw(
          createEvent('cloud.message.failed', {
            messageId: 'current',
            accepted: true,
            delivery: 'sent',
            reason: 'control_disconnected',
          })
        );
        expect(snapshot()).toMatchObject({
          activity: { type: 'idle' },
          agentStatus: { type: 'error', message: 'Message delivery failed' },
          isStreaming: false,
          canSend: true,
          pendingQuestions: [],
          pendingPermissions: [],
        });
        expect(webSocketConstructor).toHaveBeenCalledTimes(1);
      } finally {
        manager.destroy();
      }
    }
  );

  it.each([
    { reason: 'control_disconnected', recovered: true },
    { reason: 'interrupted', recovered: true },
    { reason: 'control_disconnected', recovered: false },
    { reason: 'interrupted', recovered: false },
  ])(
    'settles idle reconnect after $reason (recovered: $recovered)',
    async ({ reason, recovered }) => {
      const { manager, store, snapshot, createEvent } = createManager();
      try {
        await manager.switchSession(TEST_KILO_ID);
        await flushConnect();
        sendRaw(createEvent('cloud.message.sent', { messageId: 'previous-turn' }));
        sendRaw(
          createEvent('cloud.message.failed', {
            messageId: 'previous-turn',
            accepted: true,
            delivery: 'sent',
            reason,
            error: 'Previous turn failed',
          })
        );
        const failureStatus =
          reason === 'interrupted'
            ? { type: 'interrupted' }
            : { type: 'error', message: 'Previous turn failed' };
        expect(snapshot().agentStatus).toEqual(failureStatus);
        const failedDelivery = store.get(manager.atoms.pendingMessages).get('previous-turn');
        const failureIndicator = store.get(manager.atoms.statusIndicator);
        expect(failedDelivery?.status).toBe('failed');
        expect(failureIndicator).not.toBeNull();

        if (recovered) {
          sendRaw(createEvent('cloud.message.sent', { messageId: 'recovery-turn' }));
          expect(snapshot().agentStatus).toEqual({ type: 'idle' });
          sendRaw(createEvent('cloud.message.completed', { messageId: 'recovery-turn' }));
        }
        sendRaw(
          createEvent('connected', {
            activeMessageId: null,
            sessionStatus: { type: 'idle' },
            cloudStatus: { type: 'ready' },
          })
        );

        expect(snapshot()).toMatchObject({
          activity: { type: 'idle' },
          agentStatus: recovered ? { type: 'idle' } : failureStatus,
          isStreaming: false,
          canSend: true,
        });
        expect(store.get(manager.atoms.statusIndicator)).toEqual(
          recovered ? null : failureIndicator
        );
        expect(store.get(manager.atoms.pendingMessages).get('previous-turn')).toEqual(
          failedDelivery
        );
        expect(store.get(manager.atoms.pendingMessages).has('recovery-turn')).toBe(false);
      } finally {
        manager.destroy();
      }
    }
  );

  it.each([
    { name: 'explicit null identity', data: { activeMessageId: null } },
    { name: 'authoritative idle status', data: { sessionStatus: { type: 'idle' } } },
  ])('forgets the previous turn on connected with $name', async ({ data }) => {
    const { manager, snapshot, requestInput, createEvent, kilocode } = createManager();
    try {
      await manager.switchSession(TEST_KILO_ID);
      await flushConnect();
      sendRaw(createEvent('cloud.message.sent', { messageId: 'old' }));
      sendRaw(createEvent('connected', { ...data, cloudStatus: { type: 'ready' } }));
      sendRaw(kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } }));
      requestInput();
      const before = snapshot();
      sendRaw(
        createEvent('cloud.message.failed', {
          messageId: 'old',
          accepted: true,
          delivery: 'sent',
          reason: 'control_disconnected',
        })
      );
      expect(snapshot()).toEqual(before);
    } finally {
      manager.destroy();
    }
  });

  it('retains sent identity across a legacy reconnect without an active identity', async () => {
    const { manager, snapshot, requestInput, createEvent, kilocode } = createManager();
    try {
      await manager.switchSession(TEST_KILO_ID);
      await flushConnect();
      sendRaw(
        createEvent('cloud.message.sent', { messageId: 'active', executionId: 'compat-execution' })
      );
      sendRaw(kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } }));
      mockWs.onclose?.({ code: 1008, reason: 'unauthorized', wasClean: false } as CloseEvent);
      await flushConnect();
      sendRaw(createEvent('connected', { cloudStatus: { type: 'ready' } }));
      sendRaw(kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } }));
      requestInput();
      expect(webSocketConstructor).toHaveBeenCalledTimes(2);

      sendRaw(
        createEvent('cloud.message.failed', {
          messageId: 'active',
          executionId: 'compat-execution',
          error: 'The message failed',
          reason: 'wrapper_disconnected',
        })
      );
      expect(snapshot()).toMatchObject({
        activity: { type: 'idle' },
        agentStatus: { type: 'error', message: 'The message failed' },
        isStreaming: false,
        canSend: true,
        pendingQuestions: [],
        pendingPermissions: [],
      });
      expect(webSocketConstructor).toHaveBeenCalledTimes(2);
    } finally {
      manager.destroy();
    }
  });

  it('settles a remotely submitted accepted turn without an idle frame or reconnect', async () => {
    const { manager, store, sent, snapshot, createEvent, kilocode } = createManager();
    const messageId = 'msg_018f1e2d3c4bActiveMsgAbCdE';
    const assistantId = 'msg_018f1e2d3c4cAssistMsgAbCdE';
    const prompt = '__fake__:gate:active-runtime-failure';
    try {
      await manager.switchSession(TEST_KILO_ID);
      await flushConnect();
      mockWs.onopen?.(new Event('open'));
      sendRaw(
        createEvent('connected', {
          sessionStatus: { type: 'idle' },
          cloudStatus: { type: 'ready' },
        })
      );
      sendRaw(
        createEvent('cloud.message.queued', { messageId, content: prompt, delivery: 'queued' })
      );
      sendRaw(createEvent('cloud.message.sent', { messageId, delivery: 'sent' }));
      sendRaw(kilocode('message.updated', { info: userMsg(messageId, TEST_KILO_ID) }));
      sendRaw(
        kilocode('message.part.updated', {
          part: textPart('prompt', messageId, prompt, TEST_KILO_ID),
        })
      );
      sendRaw(kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } }));
      sendRaw(
        kilocode('message.updated', { info: assistantMsg(assistantId, messageId, TEST_KILO_ID) })
      );
      expect(sent).toEqual([]);
      expect(snapshot()).toMatchObject({ activity: { type: 'busy' }, isStreaming: true });
      const transcript = store.get(manager.atoms.messagesList);

      sendRaw({
        eventId: 620,
        sessionId: TEST_CLOUD_AGENT_ID,
        streamEventType: 'cloud.message.failed',
        timestamp: '2026-08-30T22:48:02.857Z',
        data: {
          messageId,
          status: 'failed',
          delivery: 'sent',
          accepted: true,
          reason: 'control_disconnected',
          timestamp: 1788129955465,
        },
      });

      expect(snapshot()).toMatchObject({
        activity: { type: 'idle' },
        agentStatus: { type: 'error', message: 'Message delivery failed' },
        isStreaming: false,
        canSend: true,
      });
      expect(store.get(manager.atoms.statusIndicator)).toMatchObject({
        type: 'error',
        message: 'Message delivery failed',
      });
      expect(store.get(manager.atoms.pendingMessages).get(messageId)).toEqual({
        status: 'failed',
        error: 'Message delivery failed',
        reason: 'execution',
      });
      expect(store.get(manager.atoms.messagesList)).toEqual(transcript);
      expect(transcript.map(message => message.info.id)).toEqual([messageId, assistantId]);
      expect(webSocketConstructor).toHaveBeenCalledTimes(1);
      expect(mockWs.close).not.toHaveBeenCalled();

      expect(
        await manager.send({
          payload: {
            type: 'prompt',
            prompt: 'Continue in this chat',
            mode: 'code',
            model: 'kilo/fake-deterministic',
          },
        })
      ).toBe(true);
      const followupId = sent[0]?.messageId;
      expect(followupId).toBeDefined();
      sendRaw(createEvent('cloud.message.sent', { messageId: followupId, delivery: 'sent' }));
      sendRaw(kilocode('session.status', { sessionID: TEST_KILO_ID, status: { type: 'busy' } }));
      expect(snapshot()).toMatchObject({
        activity: { type: 'busy' },
        agentStatus: { type: 'idle' },
        isStreaming: true,
      });
      expect(store.get(manager.atoms.pendingMessages).get(messageId)?.status).toBe('failed');
      expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });
});
