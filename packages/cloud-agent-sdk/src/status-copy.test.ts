/**
 * Proves the SDK's locale-free status seam: every user-visible string the SDK
 * writes itself carries a stable `code` beside the unchanged English
 * `message`. The web app renders `message`; a localized client renders `code`.
 */
import { createStore } from 'jotai';
import { createServiceState } from './service-state';
import type { ServiceStateConfig } from './service-state';
import { createSessionManager, formatError, formatErrorDetail } from './session-manager';
import type { FetchedSessionData, SessionManagerConfig } from './session-manager';
import type {
  AgentStatus,
  CloudStatus,
  MessageDeliveryState,
  ResolvedSession,
  SessionActivity,
  SessionInfo,
  SdkStatusMessageCode,
} from './types';
import { kiloId, cloudAgentId } from './test-helpers';

const EXPECTED_COPY: Record<SdkStatusMessageCode, string> = {
  'agent-connection-lost': 'Agent connection lost',
  'session-stopped': 'Session stopped',
  'session-terminated': 'Session terminated',
  'setting-up-environment': 'Setting up environment…',
  'wrapping-up': 'Wrapping up…',
  committing: 'Committing…',
  committed: 'Committed',
  'commit-failed': 'Commit failed',
  'message-delivery-failed': 'Message failed to deliver',
  'failed-to-stop-execution': 'Failed to stop execution',
  'child-session-not-found': 'This session is no longer available.',
  'selected-model-unavailable':
    'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.',
  'insufficient-credits':
    'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
  'not-authorized': 'You are not authorized to use the Cloud Agent.',
  'service-unavailable': 'Service is unavailable right now. Please try again.',
  'previous-task-in-progress': 'Previous task is still finishing up. Please wait a moment.',
  'service-temporarily-unavailable':
    'Service is temporarily unavailable. Please retry in a moment.',
  'generic-error': 'Something went wrong. Please retry in a moment.',
  'connection-lost': 'Connection lost. Please retry in a moment.',
  'connection-failed': 'Connection failed. Please retry in a moment.',
};

/** Codes observed while driving the emitters. Filled by `record`. */
const observed = new Map<SdkStatusMessageCode, string>();

function record(code: SdkStatusMessageCode, message: string): void {
  expect(message).toBe(EXPECTED_COPY[code]);
  observed.set(code, message);
}

function recordIndicator(indicator: { message: string; code?: SdkStatusMessageCode } | null): void {
  if (!indicator) throw new Error('expected a status indicator');
  if (!indicator.code) throw new Error('expected the indicator to carry a code');
  record(indicator.code, indicator.message);
}

// ---------------------------------------------------------------------------
// createSessionManager harness — mirrors createMockConfig in
// session-manager.test.ts so the manager drives the real indicator mapping.
// ---------------------------------------------------------------------------

const mockSessionCallbacks: {
  onResolved?: (resolved: ResolvedSession) => void;
  onSessionCreated?: (info: SessionInfo) => void;
  onError?: (message: string) => void;
  onMessageFailed?: (
    messageId: string,
    state: Extract<MessageDeliveryState, { status: 'failed' }>
  ) => void;
} = {};

const mockSession = {
  connect: jest.fn(() => {
    mockSessionCallbacks.onResolved?.({
      type: 'cloud-agent',
      kiloSessionId: kiloId('ses-1'),
      cloudAgentSessionId: cloudAgentId('agent-1'),
    });
    mockSessionCallbacks.onSessionCreated?.({ id: 'ses-1' });
  }),
  disconnect: jest.fn(),
  destroy: jest.fn(),
  send: jest.fn(() => Promise.resolve(undefined)),
  interrupt: jest.fn(() => Promise.resolve({})),
  cancelQueuedMessage: jest.fn(),
  answer: jest.fn(),
  reject: jest.fn(),
  respondToPermission: jest.fn(),
  acceptSuggestion: jest.fn(),
  dismissSuggestion: jest.fn(),
  retryRemoteModels: jest.fn(),
  retryRemoteCommands: jest.fn(),
  createRemoteSession: jest.fn(),
  exitRemoteSession: jest.fn(() => Promise.resolve()),
  canSend: true,
  canInterrupt: true,
  state: {
    subscribe: jest.fn((callback: () => void) => {
      callback();
      return () => {};
    }),
    getActivity: jest.fn((): SessionActivity => ({ type: 'idle' })),
    getStatus: jest.fn((): AgentStatus => ({ type: 'idle' })),
    getCloudStatus: jest.fn((): CloudStatus | null => null),
    getSetupLog: jest.fn((): readonly string[] => []),
    getCommits: jest.fn(() => []),
    clearCommits: jest.fn(),
    getQuestion: jest.fn(() => null),
    getSessionInfo: jest.fn(() => null),
    getPermission: jest.fn(() => null),
    getSuggestion: jest.fn(() => null),
    getPendingMessages: jest.fn((): ReadonlyMap<string, MessageDeliveryState> => new Map()),
    clearFailedMessage: jest.fn(),
  },
  storage: null as unknown,
};

jest.mock('./session', () => ({
  REMOTE_SESSION_EXIT_NOT_SUPPORTED: 'Remote session exit is not supported for the current session',
  REMOTE_SESSION_CREATION_NOT_SUPPORTED:
    'Remote session creation is not supported for the current session',
  createCloudAgentSession: jest.fn(
    (sessionConfig: {
      onResolved?: (resolved: ResolvedSession) => void;
      onSessionCreated?: (info: SessionInfo) => void;
      onError?: (message: string) => void;
      onMessageFailed?: (
        messageId: string,
        state: Extract<MessageDeliveryState, { status: 'failed' }>
      ) => void;
    }) => {
      mockSessionCallbacks.onResolved = sessionConfig.onResolved;
      mockSessionCallbacks.onSessionCreated = sessionConfig.onSessionCreated;
      mockSessionCallbacks.onError = sessionConfig.onError;
      mockSessionCallbacks.onMessageFailed = sessionConfig.onMessageFailed;
      return mockSession;
    }
  ),
}));

const defaultFetchedSession = {
  kiloSessionId: kiloId('ses-1'),
  cloudAgentSessionId: cloudAgentId('agent-1'),
  title: 'Test Session',
  organizationId: null,
  gitUrl: 'https://github.com/test/repo.git',
  gitBranch: 'main',
  mode: 'code',
  model: 'claude-3-5-sonnet',
  variant: null,
  repository: 'test/repo',
  isInitiated: true,
  needsLegacyPrepare: false,
  isPreparingAsync: false,
  prompt: 'Initial prompt',
  initialMessageId: 'msg_0123456789abcdefghijklmnop',
  associatedPr: null,
} satisfies FetchedSessionData;

function createMockConfig(overrides: Partial<SessionManagerConfig> = {}): SessionManagerConfig {
  return {
    store: createStore(),
    userWebConnection: { marker: 'test-user-web-connection' } as never,
    resolveSession: jest.fn().mockResolvedValue({
      type: 'cloud-agent',
      kiloSessionId: kiloId('ses-1'),
      cloudAgentSessionId: cloudAgentId('agent-1'),
    }),
    getTicket: jest.fn().mockResolvedValue('ticket-123'),
    fetchSnapshot: jest.fn().mockResolvedValue({ info: {}, messages: [] }),
    api: {
      send: jest.fn().mockResolvedValue({}),
      interrupt: jest.fn().mockResolvedValue({}),
      answer: jest.fn().mockResolvedValue({}),
      reject: jest.fn().mockResolvedValue({}),
      respondToPermission: jest.fn().mockResolvedValue({}),
    },
    prepare: jest.fn().mockResolvedValue({
      cloudAgentSessionId: cloudAgentId('agent-new'),
      kiloSessionId: kiloId('ses-new'),
    }),
    initiate: jest.fn().mockResolvedValue({}),
    fetchSession: jest.fn().mockResolvedValue(defaultFetchedSession),
    ...overrides,
  };
}

function atomValue<T>(store: ReturnType<typeof createStore>, atom: { read: unknown }): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return store.get(atom as any) as T;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockSessionCallbacks)) {
    delete mockSessionCallbacks[key as keyof typeof mockSessionCallbacks];
  }
  mockSession.canSend = true;
  mockSession.canInterrupt = true;
  mockSession.state.getActivity.mockReturnValue({ type: 'idle' });
  mockSession.state.getStatus.mockReturnValue({ type: 'idle' });
  mockSession.state.getCloudStatus.mockReturnValue(null);
  mockSession.state.subscribe.mockImplementation((callback: () => void) => {
    callback();
    return () => {};
  });
  mockSession.interrupt.mockResolvedValue({});
});

describe('service state copy codes', () => {
  function makeConfig(overrides?: Partial<ServiceStateConfig>): ServiceStateConfig {
    return { rootSessionId: 'root-1', ...overrides };
  }

  it('codes the SDK-written stopped-error status', () => {
    const state = createServiceState(makeConfig());
    state.process({ type: 'stopped', reason: 'error' });

    const status = state.getStatus();
    if (status.type !== 'error') throw new Error('expected error status');
    record('session-terminated', status.message);
  });

  it('codes the default Committing… autocommit status', () => {
    const state = createServiceState(makeConfig());
    state.process({ type: 'autocommit_started', messageId: 'msg-1' });

    const status = state.getStatus();
    if (status.type !== 'autocommit') throw new Error('expected autocommit status');
    expect(status).toMatchObject({ step: 'started' });
    record('committing', status.message);
  });

  it('codes the Committed fallback but not commit data', () => {
    const state = createServiceState(makeConfig());
    state.process({ type: 'autocommit_completed', messageId: 'msg-1', success: true });

    const status = state.getStatus();
    if (status.type !== 'autocommit') throw new Error('expected autocommit status');
    record('committed', status.message);

    const withData = createServiceState(makeConfig());
    withData.process({
      type: 'autocommit_completed',
      messageId: 'msg-1',
      success: true,
      commitHash: 'abc123',
      commitMessage: 'feat: add feature',
    });
    const dataStatus = withData.getStatus();
    if (dataStatus.type !== 'autocommit') throw new Error('expected autocommit status');
    expect(dataStatus.message).toBe('abc123 feat: add feature');
    expect(dataStatus.code).toBeUndefined();
  });

  it('codes the default Commit failed status but not forwarded event text', () => {
    const state = createServiceState(makeConfig());
    state.process({ type: 'autocommit_completed', messageId: 'msg-1', success: false });

    const status = state.getStatus();
    if (status.type !== 'autocommit') throw new Error('expected autocommit status');
    record('commit-failed', status.message);

    const forwarded = createServiceState(makeConfig());
    forwarded.process({
      type: 'autocommit_completed',
      messageId: 'msg-1',
      success: false,
      message: 'Git conflict',
    });
    const forwardedStatus = forwarded.getStatus();
    if (forwardedStatus.type !== 'autocommit') throw new Error('expected autocommit status');
    expect(forwardedStatus.message).toBe('Git conflict');
    expect(forwardedStatus.code).toBeUndefined();
  });
});

describe('session manager indicator copy codes', () => {
  it('codes the generic preparing and finalizing indicators', async () => {
    const preparing = createMockConfig();
    mockSession.state.getCloudStatus.mockReturnValue({ type: 'preparing' });
    const preparingManager = createSessionManager(preparing);
    await preparingManager.switchSession(kiloId('ses-1'));
    recordIndicator(
      atomValue<{ message: string; code?: SdkStatusMessageCode } | null>(
        preparing.store,
        preparingManager.atoms.statusIndicator
      )
    );

    const finalizing = createMockConfig();
    mockSession.state.getCloudStatus.mockReturnValue({ type: 'finalizing' });
    const finalizingManager = createSessionManager(finalizing);
    await finalizingManager.switchSession(kiloId('ses-1'));
    recordIndicator(
      atomValue<{ message: string; code?: SdkStatusMessageCode } | null>(
        finalizing.store,
        finalizingManager.atoms.statusIndicator
      )
    );
  });

  it('codes the disconnected and interrupted indicators', async () => {
    const disconnected = createMockConfig();
    mockSession.state.getStatus.mockReturnValue({ type: 'disconnected' });
    const disconnectedManager = createSessionManager(disconnected);
    await disconnectedManager.switchSession(kiloId('ses-1'));
    recordIndicator(
      atomValue<{ message: string; code?: SdkStatusMessageCode } | null>(
        disconnected.store,
        disconnectedManager.atoms.statusIndicator
      )
    );

    const interrupted = createMockConfig();
    mockSession.state.getStatus.mockReturnValue({ type: 'interrupted' });
    const interruptedManager = createSessionManager(interrupted);
    await interruptedManager.switchSession(kiloId('ses-1'));
    recordIndicator(
      atomValue<{ message: string; code?: SdkStatusMessageCode } | null>(
        interrupted.store,
        interruptedManager.atoms.statusIndicator
      )
    );
  });

  it('codes the child-session not-found indicator', async () => {
    const config = createMockConfig({
      fetchSession: jest.fn().mockRejectedValue({ data: { code: 'NOT_FOUND' } }),
    });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));

    recordIndicator(
      atomValue<{ message: string; code?: SdkStatusMessageCode } | null>(
        config.store,
        mgr.atoms.statusIndicator
      )
    );
  });

  it('codes the message-delivery-failed indicator', async () => {
    const config = createMockConfig();
    const mgr = createSessionManager(config);
    await mgr.switchSession(kiloId('ses-1'));

    mockSessionCallbacks.onMessageFailed?.('m1', {
      status: 'failed',
      error: 'boom',
      reason: 'exhausted',
    });

    recordIndicator(
      atomValue<{ message: string; code?: SdkStatusMessageCode } | null>(
        config.store,
        mgr.atoms.statusIndicator
      )
    );
  });

  it('codes the failed-to-stop-execution indicator', async () => {
    const config = createMockConfig();
    const mgr = createSessionManager(config);
    await mgr.switchSession(kiloId('ses-1'));

    mockSession.interrupt.mockRejectedValueOnce(new Error('interrupt failed'));
    await mgr.interrupt();

    recordIndicator(
      atomValue<{ message: string; code?: SdkStatusMessageCode } | null>(
        config.store,
        mgr.atoms.statusIndicator
      )
    );
  });

  it('codes the session-stopped indicator on a successful interrupt', async () => {
    const config = createMockConfig();
    const mgr = createSessionManager(config);
    await mgr.switchSession(kiloId('ses-1'));

    await mgr.interrupt();

    recordIndicator(
      atomValue<{ message: string; code?: SdkStatusMessageCode } | null>(
        config.store,
        mgr.atoms.statusIndicator
      )
    );
  });
});

describe('formatErrorDetail pairs each error string with its code', () => {
  it.each<[string, unknown, SdkStatusMessageCode]>([
    [
      'selected model unavailable',
      new Error('SELECTED MODEL IS NOT AVAILABLE FOR THIS CLOUD AGENT SESSION'),
      'selected-model-unavailable',
    ],
    ['402 code', { data: { code: 'PAYMENT_REQUIRED' } }, 'insufficient-credits'],
    ['402 status', { data: { httpStatus: 402 } }, 'insufficient-credits'],
    ['UNAUTHORIZED', { data: { code: 'UNAUTHORIZED' } }, 'not-authorized'],
    ['FORBIDDEN', { data: { code: 'FORBIDDEN' } }, 'not-authorized'],
    ['NOT_FOUND', { data: { code: 'NOT_FOUND' } }, 'service-unavailable'],
    ['CONFLICT', { data: { code: 'CONFLICT' } }, 'previous-task-in-progress'],
    ['409 status', { data: { httpStatus: 409 } }, 'previous-task-in-progress'],
    [
      'SERVICE_UNAVAILABLE',
      { data: { code: 'SERVICE_UNAVAILABLE' } },
      'service-temporarily-unavailable',
    ],
    ['503 status', { data: { httpStatus: 503 } }, 'service-temporarily-unavailable'],
    ['unknown code', { data: { code: 'SOME_UNKNOWN_CODE' } }, 'generic-error'],
    ['non-Error', 'just a string', 'generic-error'],
    ['ECONNREFUSED', new Error('ECONNREFUSED'), 'connection-lost'],
    ['fetch failed', new Error('fetch failed: network error'), 'connection-lost'],
    ['other Error', new Error('something else'), 'connection-failed'],
  ])('maps %s to its exact message and code', (_label, err, code) => {
    const detail = formatErrorDetail(err);
    expect(detail).toEqual({ message: EXPECTED_COPY[code], code });
    expect(formatError(err)).toBe(EXPECTED_COPY[code]);
    record(code, formatError(err));
  });
});

// ---------------------------------------------------------------------------
// The map above is the contract: every union member must be emitted above.
// ---------------------------------------------------------------------------

describe('SdkStatusMessageCode coverage', () => {
  it('emits every code in the union with its exact English copy', () => {
    expect([...observed.keys()].sort()).toEqual(Object.keys(EXPECTED_COPY).sort());
    expect(observed.size).toBe(Object.keys(EXPECTED_COPY).length);
  });
});
