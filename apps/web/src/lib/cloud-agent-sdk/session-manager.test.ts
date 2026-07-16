import { createStore, atom } from 'jotai';
import {
  cliModelLabel,
  createSessionManager,
  formatError,
  type SessionManagerConfig,
  type FetchedSessionData,
  type StoredMessage,
} from './session-manager';
import {
  createCloudAgentSession,
  REMOTE_CLI_EXIT_NOT_SUPPORTED,
  REMOTE_SESSION_CREATION_NOT_SUPPORTED,
} from './session';
import type {
  CloudAgentSession,
  CloudAgentSessionSendInput,
  CloudAgentSessionAnswerInput,
  CloudAgentSessionRejectInput,
  CloudAgentSessionRespondToPermissionInput,
  CloudAgentSessionAcceptSuggestionInput,
  CloudAgentSessionDismissSuggestionInput,
} from './session';
import type { JotaiSessionStorage } from './storage/jotai';
import type { AssistantMessage, UserMessage } from '@/types/opencode.gen';
import { kiloId, cloudAgentId, stubUserMessage, stubTextPart, makeSnapshot } from './test-helpers';
import type {
  CloudStatus,
  MessageDeliveryState,
  ResolvedSession,
  SessionActivity,
  SessionInfo,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
} from './types';
import type { RemoteModelState } from './remote-model-catalog';
import type { RemoteCommandState } from './remote-command-catalog';
import type { NormalizedEvent } from './normalizer';

// ---------------------------------------------------------------------------
// Mock createCloudAgentSession — prevents real WebSocket connections
// ---------------------------------------------------------------------------

type MockSession = Omit<
  jest.Mocked<CloudAgentSession>,
  | 'state'
  | 'storage'
  | 'send'
  | 'interrupt'
  | 'answer'
  | 'reject'
  | 'respondToPermission'
  | 'acceptSuggestion'
  | 'dismissSuggestion'
  | 'exitRemoteCli'
> & {
  state: jest.Mocked<CloudAgentSession['state']>;
  storage: JotaiSessionStorage | null;
  send: jest.Mock<Promise<unknown>, [CloudAgentSessionSendInput]>;
  interrupt: jest.Mock<Promise<unknown>, []>;
  answer: jest.Mock<Promise<unknown>, [CloudAgentSessionAnswerInput]>;
  reject: jest.Mock<Promise<unknown>, [CloudAgentSessionRejectInput]>;
  respondToPermission: jest.Mock<Promise<unknown>, [CloudAgentSessionRespondToPermissionInput]>;
  acceptSuggestion: jest.Mock<Promise<unknown>, [CloudAgentSessionAcceptSuggestionInput]>;
  dismissSuggestion: jest.Mock<Promise<unknown>, [CloudAgentSessionDismissSuggestionInput]>;
  exitRemoteCli: jest.Mock<Promise<void>, []>;
};

const mockSession = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  destroy: jest.fn(),
  send: jest.fn(),
  interrupt: jest.fn(),
  answer: jest.fn(),
  reject: jest.fn(),
  respondToPermission: jest.fn(),
  acceptSuggestion: jest.fn(),
  dismissSuggestion: jest.fn(),
  retryRemoteModels: jest.fn(),
  retryRemoteCommands: jest.fn(),
  createRemoteSession: jest.fn(() => Promise.resolve(kiloId('ses_12345678901234567890123456'))),
  exitRemoteCli: jest.fn(() => Promise.resolve()),
  canSend: true,
  canInterrupt: true,
  state: {
    subscribe: jest.fn(callback => {
      callback();
      return () => {};
    }),
    getActivity: jest.fn((): SessionActivity => ({ type: 'idle' })),
    getStatus: jest.fn<{ type: 'idle' | 'disconnected' }, []>(() => ({ type: 'idle' })),
    getCloudStatus: jest.fn<CloudStatus | null, []>(() => null),
    getSetupLog: jest.fn<readonly string[], []>(() => []),
    getQuestion: jest.fn(() => null),
    getSessionInfo: jest.fn(() => null),
    getPermission: jest.fn(() => null),
    getSuggestion: jest.fn(() => null),
    getPendingMessages: jest.fn<ReadonlyMap<string, MessageDeliveryState>, []>(() => new Map()),
  },
  storage: null as JotaiSessionStorage | null,
} as unknown as MockSession;

const mockSessionCallbacks: {
  onSessionCreated?: (info: SessionInfo) => void;
  onSessionUpdated?: (info: SessionInfo) => void;
  onReplayComplete?: () => void;

  onQuestionAsked?: (...args: unknown[]) => void;
  onQuestionResolved?: (...args: unknown[]) => void;
  onPermissionAsked?: (...args: unknown[]) => void;
  onPermissionResolved?: (...args: unknown[]) => void;
  onSuggestionAsked?: (...args: unknown[]) => void;
  onSuggestionResolved?: (...args: unknown[]) => void;
  onResolved?: (resolved: ResolvedSession) => void;
  onRemoteModelStateChange?: (state: RemoteModelState) => void;
  onRemoteCommandStateChange?: (state: RemoteCommandState) => void;
  onTransportCapabilityChange?: () => void;
  onEvent?: (event: NormalizedEvent) => void;
  onMessageQueued?: (messageId: string) => void;
  onMessageCompleted?: (messageId: string) => void;
  onMessageFailed?: (
    messageId: string,
    state: Extract<MessageDeliveryState, { status: 'failed' }>
  ) => void;
  onError?: (message: string) => void;
} = {};

let latestStorage: JotaiSessionStorage | null = null;

jest.mock('./session', () => ({
  REMOTE_CLI_EXIT_NOT_SUPPORTED: 'Remote CLI exit is not supported for the current session',
  REMOTE_SESSION_CREATION_NOT_SUPPORTED:
    'Remote session creation is not supported for the current session',
  createCloudAgentSession: jest.fn(
    (sessionConfig: {
      kiloSessionId: string;
      storage: JotaiSessionStorage;
      onSessionCreated?: (info: SessionInfo) => void;
      onSessionUpdated?: (info: SessionInfo) => void;
      onReplayComplete?: () => void;

      onQuestionAsked?: (...args: unknown[]) => void;
      onQuestionResolved?: (...args: unknown[]) => void;
      onPermissionAsked?: (...args: unknown[]) => void;
      onPermissionResolved?: (...args: unknown[]) => void;
      onSuggestionAsked?: (...args: unknown[]) => void;
      onSuggestionResolved?: (...args: unknown[]) => void;
      onResolved?: (resolved: ResolvedSession) => void;
      onRemoteModelStateChange?: (state: RemoteModelState) => void;
      onRemoteCommandStateChange?: (state: RemoteCommandState) => void;
      onTransportCapabilityChange?: () => void;
      onEvent?: (event: NormalizedEvent) => void;
      onMessageQueued?: (messageId: string) => void;
      onMessageCompleted?: (messageId: string) => void;
      onMessageFailed?: (
        messageId: string,
        state: Extract<MessageDeliveryState, { status: 'failed' }>
      ) => void;
      onError?: (message: string) => void;
      transport?: {
        userWebConnection?: unknown;
        fetchSnapshotPage?: (
          kiloSessionId: string,
          options: { cursor?: string }
        ) => Promise<unknown>;
        onInitialPageLoaded?: (page: unknown) => void;
      };
    }) => {
      latestStorage = sessionConfig.storage;
      mockSession.storage = sessionConfig.storage;
      // Capture the onSessionCreated callback and fire it when connect() is called,
      // simulating what the real session does after connecting and replaying the snapshot.
      mockSession.connect.mockImplementation(() => {
        sessionConfig.onResolved?.({
          type: 'cloud-agent',
          kiloSessionId: kiloId(sessionConfig.kiloSessionId),
          cloudAgentSessionId: cloudAgentId('agent-1'),
        });
        // Simulate the transport's initial bounded read so the manager's
        // pagination state is populated. The real transport would call
        // `fetchSnapshotPage` and then `onInitialPageLoaded` with the page,
        // or surface a typed failure via `onError`.
        const transport = sessionConfig.transport;
        if (transport?.fetchSnapshotPage) {
          void Promise.resolve(transport.fetchSnapshotPage(sessionConfig.kiloSessionId, {})).then(
            page => {
              if (page && typeof page === 'object' && 'kind' in page) {
                if (page.kind === 'success' && transport.onInitialPageLoaded) {
                  transport.onInitialPageLoaded(page);
                } else if (page.kind !== 'success' && sessionConfig.onError) {
                  // Mirror the real transport's typed-failure handling:
                  // it surfaces a stable error message via the manager's
                  // `onError` channel so the standard session-error UI
                  // shows the failure.
                  const message =
                    page.kind === 'retryable_failure'
                      ? 'Session history temporarily unavailable'
                      : page.kind === 'too_large'
                        ? 'Session history too large to load'
                        : 'Session history is unavailable';
                  sessionConfig.onError(message);
                }
              }
            }
          );
        }
        sessionConfig.onSessionCreated?.({ id: sessionConfig.kiloSessionId });
      });
      mockSessionCallbacks.onSessionCreated = sessionConfig.onSessionCreated;
      mockSessionCallbacks.onSessionUpdated = sessionConfig.onSessionUpdated;
      mockSessionCallbacks.onReplayComplete = sessionConfig.onReplayComplete;
      mockSessionCallbacks.onQuestionAsked = sessionConfig.onQuestionAsked;
      mockSessionCallbacks.onQuestionResolved = sessionConfig.onQuestionResolved;
      mockSessionCallbacks.onPermissionAsked = sessionConfig.onPermissionAsked;
      mockSessionCallbacks.onPermissionResolved = sessionConfig.onPermissionResolved;
      mockSessionCallbacks.onSuggestionAsked = sessionConfig.onSuggestionAsked;
      mockSessionCallbacks.onSuggestionResolved = sessionConfig.onSuggestionResolved;
      mockSessionCallbacks.onResolved = sessionConfig.onResolved;
      mockSessionCallbacks.onRemoteModelStateChange = sessionConfig.onRemoteModelStateChange;
      mockSessionCallbacks.onRemoteCommandStateChange = sessionConfig.onRemoteCommandStateChange;
      mockSessionCallbacks.onTransportCapabilityChange = sessionConfig.onTransportCapabilityChange;
      mockSessionCallbacks.onEvent = sessionConfig.onEvent;
      mockSessionCallbacks.onMessageQueued = sessionConfig.onMessageQueued;
      mockSessionCallbacks.onMessageCompleted = sessionConfig.onMessageCompleted;
      mockSessionCallbacks.onMessageFailed = sessionConfig.onMessageFailed;
      mockSessionCallbacks.onError = sessionConfig.onError;
      return mockSession;
    }
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const remoteCatalog = {
  protocolVersion: 1,
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        {
          id: 'claude-sonnet-4',
          name: 'Claude Sonnet 4',
          variants: ['high'],
          capabilities: { attachment: true, reasoning: true },
          limits: { context: 200_000, output: 64_000 },
        },
      ],
    },
  ],
  truncated: false,
} satisfies NonNullable<RemoteModelState['catalog']>;

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

function createStoredMessage(
  messageId: string,
  sessionID: string,
  role: 'user' | 'assistant',
  created = 1
): StoredMessage {
  const info: UserMessage | AssistantMessage =
    role === 'user'
      ? stubUserMessage({
          id: messageId,
          sessionID,
          time: { created },
          agent: 'test-agent',
          model: { providerID: 'test-provider', modelID: 'test-model' },
        })
      : {
          id: messageId,
          sessionID,
          role: 'assistant',
          time: { created },
          parentID: 'msg-parent',
          modelID: 'test-model',
          providerID: 'test-provider',
          mode: 'code',
          agent: 'test-agent',
          path: { cwd: '/', root: '/' },
          cost: 1,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        };

  return {
    info,
    parts: [],
  };
}

function createStoredAssistantMessage(
  messageId: string,
  sessionID: string,
  overrides: Partial<AssistantMessage> = {}
): StoredMessage {
  return {
    info: {
      id: messageId,
      sessionID,
      role: 'assistant',
      time: { created: 1 },
      parentID: 'msg-parent',
      modelID: 'anthropic/claude-sonnet-4',
      providerID: 'kilo',
      mode: 'code',
      agent: 'test-agent',
      path: { cwd: '/', root: '/' },
      cost: 1,
      tokens: {
        input: 10,
        output: 1,
        reasoning: 2,
        cache: { read: 3, write: 4 },
      },
      ...overrides,
    },
    parts: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSessionManager', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    // Reset mock session to defaults
    mockSession.connect.mockClear();
    mockSession.disconnect.mockClear();
    mockSession.destroy.mockClear();
    mockSession.send.mockClear();
    mockSession.interrupt.mockClear();
    mockSession.exitRemoteCli.mockClear();
    mockSession.exitRemoteCli.mockResolvedValue();
    mockSession.respondToPermission.mockClear();
    mockSession.canSend = true;
    mockSession.canInterrupt = true;
    mockSession.state.subscribe.mockImplementation(callback => {
      callback();
      return () => {};
    });
    mockSession.state.getStatus.mockReturnValue({ type: 'idle' });
    mockSession.state.getCloudStatus.mockReturnValue(null);
    mockSession.state.getSetupLog.mockReturnValue([]);
    mockSession.state.getPendingMessages.mockReturnValue(new Map());
    mockSession.storage = latestStorage;
    latestStorage = null;
    mockSessionCallbacks.onQuestionAsked = undefined;
    mockSessionCallbacks.onQuestionResolved = undefined;
    mockSessionCallbacks.onPermissionAsked = undefined;
    mockSessionCallbacks.onPermissionResolved = undefined;
    mockSessionCallbacks.onSessionCreated = undefined;
    mockSessionCallbacks.onSessionUpdated = undefined;
    mockSessionCallbacks.onResolved = undefined;
    mockSessionCallbacks.onRemoteModelStateChange = undefined;
    mockSessionCallbacks.onTransportCapabilityChange = undefined;
    mockSessionCallbacks.onEvent = undefined;
    mockSessionCallbacks.onMessageQueued = undefined;
    mockSessionCallbacks.onMessageCompleted = undefined;
    mockSessionCallbacks.onMessageFailed = undefined;
    mockSessionCallbacks.onError = undefined;
  });

  // -------------------------------------------------------------------------
  // switchSession
  // -------------------------------------------------------------------------

  describe('switchSession', () => {
    it('sets isLoading=true synchronously and clears it after completion', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const promise = mgr.switchSession(kiloId('ses-1'));
      expect(atomValue<boolean>(config.store, mgr.atoms.isLoading)).toBe(true);

      await promise;
      expect(atomValue<boolean>(config.store, mgr.atoms.isLoading)).toBe(false);
    });

    it('calls fetchSession with the right kiloSessionId', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-42'));
      expect(config.fetchSession).toHaveBeenCalledWith('ses-42');
    });

    it('sets sessionConfig from fetched data', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const sessionConfig = atomValue<{
        sessionId: string;
        repository: string;
        mode: string;
        model: string;
        providerID?: string | null;
        variant?: string | null;
      }>(config.store, mgr.atoms.sessionConfig);
      expect(sessionConfig).toEqual({
        sessionId: 'agent-1',
        repository: 'test/repo',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        providerID: null,
        variant: null,
        runtimeAgents: undefined,
      });
    });

    it('sets sessionId from fetched cloudAgentSessionId', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      expect(atomValue<string | null>(config.store, mgr.atoms.sessionId)).toBe('agent-1');
    });

    it('clears error on start', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      // Set an error first
      config.store.set(mgr.atoms.error, 'previous error');
      await mgr.switchSession(kiloId('ses-1'));

      expect(atomValue<string | null>(config.store, mgr.atoms.error)).toBeNull();
    });

    it('sets status indicator when fetchSession fails', async () => {
      const config = createMockConfig({
        fetchSession: jest.fn().mockRejectedValue(new Error('fetch failed')),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const indicator = atomValue<{ type: string; message: string } | null>(
        config.store,
        mgr.atoms.statusIndicator
      );
      expect(indicator).toEqual(
        expect.objectContaining({
          type: 'error',
          message: 'Connection lost. Please retry in a moment.',
        })
      );
      expect(atomValue<boolean>(config.store, mgr.atoms.isLoading)).toBe(false);
    });

    it('does not set indicator when fetchSession fails for stale session', async () => {
      let rejectFetch: (err: Error) => void;
      const slowFetch = new Promise<FetchedSessionData>((_resolve, reject) => {
        rejectFetch = reject;
      });

      const config = createMockConfig({
        fetchSession: jest
          .fn()
          .mockReturnValueOnce(slowFetch)
          .mockResolvedValue(defaultFetchedSession),
      });
      const mgr = createSessionManager(config);

      // Start first call — it will hang on slowFetch
      const first = mgr.switchSession(kiloId('ses-old'));
      // Start second call — overwrites activeSessionId
      const second = mgr.switchSession(kiloId('ses-new'));
      // Reject the first fetch — stale, should be silently ignored
      rejectFetch!(new Error('network error'));
      await first;
      await second;

      // No indicator set — stale failure silenced
      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toBeNull();
    });

    it('uses kiloSessionId as sessionConfig.sessionId when cloudAgentSessionId is null', async () => {
      const config = createMockConfig({
        fetchSession: jest.fn().mockResolvedValue({
          ...defaultFetchedSession,
          cloudAgentSessionId: null,
        }),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-cli'));

      const sessionConfig = atomValue<{ sessionId: string } | null>(
        config.store,
        mgr.atoms.sessionConfig
      );
      expect(sessionConfig?.sessionId).toBe('ses-cli');
    });

    it('includes variant from fetched data in sessionConfig', async () => {
      const config = createMockConfig({
        fetchSession: jest.fn().mockResolvedValue({
          ...defaultFetchedSession,
          variant: 'high',
        }),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const sessionConfig = atomValue<{
        sessionId: string;
        repository: string;
        mode: string;
        model: string;
        variant?: string | null;
      }>(config.store, mgr.atoms.sessionConfig);
      expect(sessionConfig?.variant).toBe('high');
    });

    it('forwards the required user web connection to session creation', async () => {
      const userWebConnection = { marker: 'shared' } as never;
      const config = createMockConfig({ userWebConnection });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const mockedCreate = jest.mocked(createCloudAgentSession);
      expect(mockedCreate.mock.calls[0][0].transport.userWebConnection).toBe(userWebConnection);
    });

    it('defaults variant to null when fetched data has no variant', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const sessionConfig = atomValue<{
        sessionId: string;
        repository: string;
        mode: string;
        model: string;
        variant?: string | null;
      }>(config.store, mgr.atoms.sessionConfig);
      expect(sessionConfig?.variant).toBe(null);
    });

    it('uses the generic setup indicator for bare preparing cloud status', async () => {
      mockSession.state.getCloudStatus.mockReturnValue({ type: 'preparing' });
      mockSession.state.subscribe.mockImplementation(callback => {
        callback();
        return () => {};
      });

      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toEqual(
        expect.objectContaining({
          type: 'progress',
          message: 'Setting up environment…',
        })
      );
    });

    it('exposes setup output and clears it when the manager is destroyed', async () => {
      mockSession.state.getSetupLog.mockReturnValue([
        'Running setup command 1 of 1: pnpm install',
        'Packages: +42',
      ]);

      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      expect(atomValue<readonly string[]>(config.store, mgr.atoms.setupLog)).toEqual([
        'Running setup command 1 of 1: pnpm install',
        'Packages: +42',
      ]);

      mgr.destroy();

      expect(atomValue<readonly string[]>(config.store, mgr.atoms.setupLog)).toEqual([]);
    });

    it('clears cloud status indicator when cloud status returns to ready', async () => {
      let subscriptionCallback = (): void => {
        throw new Error('Expected service state subscription callback');
      };
      let cloudStatus: CloudStatus | null = {
        type: 'preparing',
        message: 'Setting up environment...',
      };
      mockSession.state.getCloudStatus.mockImplementation(() => cloudStatus);
      mockSession.state.subscribe.mockImplementation(callback => {
        subscriptionCallback = callback;
        callback();
        return () => {};
      });

      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toEqual(
        expect.objectContaining({
          type: 'progress',
          message: 'Setting up environment...',
        })
      );

      cloudStatus = { type: 'ready' };
      subscriptionCallback();

      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toBeNull();
    });

    it('exposes active session type and remote model state from the live transport', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      expect(atomValue(config.store, mgr.atoms.activeSessionType)).toBe('cloud-agent');

      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      const remoteState = {
        ownerConnectionId: 'owner',
        protocol: 'v1',
        catalog: {
          protocolVersion: 1,
          providers: [],
          currentModel: {
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
            variant: 'high',
          },
          defaultModel: { providerID: 'kilo', modelID: 'kilo-auto' },
          truncated: false,
        },
        refresh: 'idle',
      } satisfies RemoteModelState;
      mockSessionCallbacks.onRemoteModelStateChange?.(remoteState);

      expect(atomValue(config.store, mgr.atoms.activeSessionType)).toBe('remote');
      expect(atomValue(config.store, mgr.atoms.remoteModelState)).toEqual(remoteState);
      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual(
        remoteState.catalog.currentModel
      );
    });

    it('replaces a catalog-derived observation when the session owner changes', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: {
          protocolVersion: 1,
          providers: [],
          currentModel: { model: { providerID: 'provider-a', modelID: 'model-a' } },
          truncated: false,
        },
        refresh: 'idle',
      });
      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'provider-a', modelID: 'model-a' },
      });

      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-b',
        protocol: 'unknown',
        refresh: 'loading',
      });
      expect(atomValue(config.store, mgr.atoms.observedModel)).toBeNull();

      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-b',
        protocol: 'v1',
        catalog: {
          protocolVersion: 1,
          providers: [],
          currentModel: { model: { providerID: 'provider-b', modelID: 'model-b' } },
          truncated: false,
        },
        refresh: 'idle',
      });
      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'provider-b', modelID: 'model-b' },
      });
    });

    it('recomputes remote send capability without marking a disconnected owner read-only', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });

      mockSession.canSend = false;
      mockSessionCallbacks.onTransportCapabilityChange?.();
      expect(atomValue(config.store, mgr.atoms.canSend)).toBe(false);
      expect(atomValue(config.store, mgr.atoms.isReadOnly)).toBe(false);

      mockSession.canSend = true;
      mockSessionCallbacks.onTransportCapabilityChange?.();
      expect(atomValue(config.store, mgr.atoms.canSend)).toBe(true);
    });

    it('delegates remote model retries to the active session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mgr.retryRemoteModels();

      expect(mockSession.retryRemoteModels).toHaveBeenCalledTimes(1);
    });

    it('keeps session metadata authoritative over replayed root message models', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onSessionCreated?.({
        id: 'ses-1',
        model: { providerID: 'openai', id: 'gpt-5', variant: 'high' },
      });
      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'openai', modelID: 'gpt-5' },
        variant: 'high',
      });

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: stubUserMessage({
          id: 'msg-root',
          sessionID: 'ses-1',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'max',
        }),
      });
      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'openai', modelID: 'gpt-5' },
        variant: 'high',
      });

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: createStoredAssistantMessage('msg-assistant', 'ses-1', {
          providerID: 'custom-provider',
          modelID: 'custom/model',
          variant: 'fast',
        }).info,
      });
      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'openai', modelID: 'gpt-5' },
        variant: 'high',
      });
    });

    it('lets a live message override a session-set model once replay has finished', async () => {
      // Regression test: `session.updated` can report a stale/default model
      // that never changes for a per-request override (the wrapper sends the
      // override straight through without persisting it to the session), so
      // once we're live, a message's own reported model must win.
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onSessionCreated?.({
        id: 'ses-1',
        model: { providerID: 'openai', id: 'gpt-5', variant: 'high' },
      });
      mockSessionCallbacks.onReplayComplete?.();

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: stubUserMessage({
          id: 'msg-live',
          sessionID: 'ses-1',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        }),
      });

      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      });
    });

    it('uses a replayed root message model when session metadata has no model', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      expect(atomValue(config.store, mgr.atoms.observedModel)).toBeNull();

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: stubUserMessage({
          id: 'msg-root',
          sessionID: 'ses-1',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        }),
      });

      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        variant: 'high',
      });
    });

    it('keeps session metadata above the catalog current model', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onSessionCreated?.({
        id: 'ses-1',
        model: { providerID: 'openai', id: 'gpt-5', variant: 'high' },
      });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: {
          ...remoteCatalog,
          currentModel: {
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          },
          defaultModel: { providerID: 'kilo', modelID: 'kilo-auto' },
        },
        refresh: 'idle',
      });

      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'openai', modelID: 'gpt-5' },
        variant: 'high',
      });
    });

    it('keeps a message-observed model when the catalog current model arrives afterward', async () => {
      // Snapshot replay and catalog discovery are two independent async
      // round-trips racing on first load. A session with history should
      // land on the model its last message actually used, not whichever of
      // the two requests happened to finish last.
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: createStoredAssistantMessage('msg-history', 'ses-1', {
          providerID: 'kilo',
          modelID: 'anthropic/claude-sonnet-4',
        }).info,
      });

      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: {
          ...remoteCatalog,
          currentModel: { model: { providerID: 'openai', modelID: 'gpt-5' } },
        },
        refresh: 'idle',
      });

      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
      });
    });

    it('applies a live session.updated model while retaining the explicit override', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const override = {
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      } as const;

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: remoteCatalog,
        refresh: 'idle',
      });
      mockSessionCallbacks.onSessionCreated?.({
        id: 'ses-1',
        model: { providerID: 'openai', id: 'gpt-5' },
      });
      mgr.setRemoteModelOverride(override);

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: createStoredAssistantMessage('msg-history', 'ses-1', {
          providerID: 'historical-provider',
          modelID: 'historical-model',
        }).info,
      });
      mockSessionCallbacks.onSessionUpdated?.({
        id: 'ses-1',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4', variant: 'high' },
      });

      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        variant: 'high',
      });
      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toEqual(override);
    });

    it('keeps an explicit override through a still-replaying observation, but clears it on owner change', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const catalog = {
        protocolVersion: 1,
        providers: [],
        truncated: false,
      } satisfies NonNullable<RemoteModelState['catalog']>;

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog,
        refresh: 'idle',
      });
      const override = {
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      } as const;
      mgr.setRemoteModelOverride(override);

      // onReplayComplete hasn't fired yet, so this message is still treated
      // as replayed history and must not clear the override (see the
      // dedicated "live" divergence test below for the post-replay case).
      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: createStoredAssistantMessage('msg-assistant', 'ses-1', {
          providerID: 'openai',
          modelID: 'gpt-5',
        }).info,
      });

      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'openai', modelID: 'gpt-5' },
      });
      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toEqual(override);

      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-b',
        protocol: 'unknown',
        refresh: 'loading',
      });
      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toBeNull();
      expect(atomValue(config.store, mgr.atoms.remoteModelState)).toEqual({
        ownerConnectionId: 'owner-b',
        protocol: 'unknown',
        refresh: 'loading',
      });
    });

    it('clears a stale override once a live message shows the CLI actually used a different model', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: remoteCatalog,
        refresh: 'idle',
      });
      mgr.setRemoteModelOverride({
        source: 'cli-catalog',
        selection: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } },
      });

      // Initial connect has finished replaying whatever history existed.
      mockSessionCallbacks.onReplayComplete?.();

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: createStoredAssistantMessage('msg-live', 'ses-1', {
          providerID: 'openai',
          modelID: 'gpt-5',
        }).info,
      });

      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toBeNull();
      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'openai', modelID: 'gpt-5' },
      });
    });

    it('clears a stale override once a live message runs the same model on a different variant', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: remoteCatalog,
        refresh: 'idle',
      });
      mgr.setRemoteModelOverride({
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      });
      mockSessionCallbacks.onReplayComplete?.();

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: createStoredAssistantMessage('msg-live', 'ses-1', {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
        }).info,
      });

      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toBeNull();
      expect(atomValue(config.store, mgr.atoms.observedModel)).toEqual({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      });
    });

    it('keeps an override whose model and variant a live message echoes back', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: remoteCatalog,
        refresh: 'idle',
      });
      const override = {
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      } as const;
      mgr.setRemoteModelOverride(override);
      mockSessionCallbacks.onReplayComplete?.();

      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: createStoredAssistantMessage('msg-live', 'ses-1', {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
          variant: 'high',
        }).info,
      });

      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toEqual(override);
    });

    it('keeps a fresh override intact through a reconnect that replays pre-override history', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: remoteCatalog,
        refresh: 'idle',
      });
      mockSessionCallbacks.onReplayComplete?.();

      const override = {
        source: 'cli-catalog',
        selection: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } },
      } as const;
      mgr.setRemoteModelOverride(override);

      // A reconnect starts a fresh replay before the override was ever used.
      mockSessionCallbacks.onSessionCreated?.({ id: 'ses-1' });
      mockSessionCallbacks.onEvent?.({
        type: 'message.updated',
        info: createStoredAssistantMessage('msg-old', 'ses-1', {
          providerID: 'openai',
          modelID: 'gpt-5',
        }).info,
      });

      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toEqual(override);

      mockSessionCallbacks.onReplayComplete?.();
      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toEqual(override);
    });

    it('clears an explicit override when the same owner changes to an incompatible protocol', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: remoteCatalog,
        refresh: 'idle',
      });
      mgr.setRemoteModelOverride({
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      });

      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'legacy',
        refresh: 'idle',
      });

      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toBeNull();
    });

    it('clears an explicit override when a same-owner catalog no longer contains its model', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: remoteCatalog,
        refresh: 'idle',
      });
      mgr.setRemoteModelOverride({
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      });

      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: {
          ...remoteCatalog,
          providers: [{ ...remoteCatalog.providers[0], models: [] }],
        },
        refresh: 'idle',
      });

      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toBeNull();
    });

    it('keeps a same-owner v1 model override but drops a removed variant', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: remoteCatalog,
        refresh: 'idle',
      });
      mgr.setRemoteModelOverride({
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      });

      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'v1',
        catalog: {
          ...remoteCatalog,
          providers: [
            {
              ...remoteCatalog.providers[0],
              models: [{ ...remoteCatalog.providers[0].models[0], variants: [] }],
            },
          ],
        },
        refresh: 'idle',
      });

      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toEqual({
        source: 'cli-catalog',
        selection: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } },
      });
    });

    it('clears remote model state and override immediately when switching sessions', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteModelStateChange?.({
        ownerConnectionId: 'owner-a',
        protocol: 'legacy',
        refresh: 'idle',
      });
      mgr.setRemoteModelOverride({
        source: 'legacy-gateway',
        selection: { model: { providerID: 'kilo', modelID: 'kilo-auto' } },
      });

      const switching = mgr.switchSession(kiloId('ses-2'));
      expect(atomValue(config.store, mgr.atoms.remoteModelState)).toEqual({
        ownerConnectionId: null,
        protocol: 'unknown',
        refresh: 'idle',
      });
      expect(atomValue(config.store, mgr.atoms.remoteModelOverride)).toBeNull();
      await switching;
    });

    it('allows attachments only for a resolved Cloud Agent session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      expect(atomValue<boolean>(config.store, mgr.atoms.supportsAttachments)).toBe(false);

      await mgr.switchSession(kiloId('ses-1'));
      expect(atomValue<boolean>(config.store, mgr.atoms.supportsAttachments)).toBe(true);

      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      expect(atomValue<boolean>(config.store, mgr.atoms.supportsAttachments)).toBe(false);

      mockSessionCallbacks.onResolved?.({ type: 'read-only', kiloSessionId: kiloId('ses-1') });
      expect(atomValue<boolean>(config.store, mgr.atoms.supportsAttachments)).toBe(false);

      const switching = mgr.switchSession(kiloId('ses-2'));
      expect(atomValue<boolean>(config.store, mgr.atoms.supportsAttachments)).toBe(false);
      await switching;
      expect(atomValue<boolean>(config.store, mgr.atoms.supportsAttachments)).toBe(true);

      mgr.destroy();
      expect(atomValue<boolean>(config.store, mgr.atoms.supportsAttachments)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Overlapping switchSession
  // -------------------------------------------------------------------------

  describe('overlapping switchSession', () => {
    it('connects one transport for concurrent switches to the same session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await Promise.all([mgr.switchSession(kiloId('ses-1')), mgr.switchSession(kiloId('ses-1'))]);

      expect(mockSession.connect).toHaveBeenCalledTimes(1);
    });

    it('first call is abandoned when second starts', async () => {
      let resolveFetch: (val: FetchedSessionData) => void;
      const slowFetch = new Promise<FetchedSessionData>(resolve => {
        resolveFetch = resolve;
      });

      const config = createMockConfig({
        fetchSession: jest
          .fn()
          .mockReturnValueOnce(slowFetch)
          .mockResolvedValue(defaultFetchedSession),
      });
      const mgr = createSessionManager(config);

      // First call hangs
      const first = mgr.switchSession(kiloId('ses-old'));
      // Second call replaces activeSessionId
      const second = mgr.switchSession(kiloId('ses-new'));

      // Resolve the first fetch (stale)
      resolveFetch!(defaultFetchedSession);
      await first;
      await second;

      // Session config should reflect ses-new, not ses-old
      expect(config.fetchSession).toHaveBeenCalledTimes(2);
      const sessionConfig = atomValue<{ sessionId: string } | null>(
        config.store,
        mgr.atoms.sessionConfig
      );
      expect(sessionConfig?.sessionId).toBe('agent-1');
    });

    it('first call does not set atoms after second starts', async () => {
      let resolveFetch: (val: FetchedSessionData) => void;
      const slowFetch = new Promise<FetchedSessionData>(resolve => {
        resolveFetch = resolve;
      });

      const firstSessionData = {
        ...defaultFetchedSession,
        cloudAgentSessionId: cloudAgentId('stale-agent'),
        model: 'stale-model',
      } satisfies FetchedSessionData;

      const config = createMockConfig({
        fetchSession: jest
          .fn()
          .mockReturnValueOnce(slowFetch)
          .mockResolvedValue(defaultFetchedSession),
      });
      const mgr = createSessionManager(config);

      const first = mgr.switchSession(kiloId('ses-old'));
      const second = mgr.switchSession(kiloId('ses-new'));

      // Resolve first with stale data — should be ignored
      resolveFetch!(firstSessionData);
      await first;
      await second;

      // sessionId should be from second call, not first
      expect(atomValue<string | null>(config.store, mgr.atoms.sessionId)).toBe('agent-1');
    });
  });

  // -------------------------------------------------------------------------
  // send
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('keeps queued follow-up sends available while the session is busy', async () => {
      mockSession.state.getActivity.mockReturnValueOnce({ type: 'busy' });
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      expect(atomValue<boolean>(config.store, mgr.atoms.isStreaming)).toBe(true);
      expect(atomValue<boolean>(config.store, mgr.atoms.canSend)).toBe(true);

      mockSession.send.mockResolvedValue(undefined);
      const accepted = await mgr.send({
        payload: {
          type: 'prompt',
          prompt: 'Queue this follow-up',
          mode: 'code',
          model: 'claude-3-5-sonnet',
        },
      });

      expect(accepted).toBe(true);
      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'Queue this follow-up',
          mode: 'code',
          model: { providerID: 'kilo', modelID: 'claude-3-5-sonnet' },
        },
        images: undefined,
      });
    });

    it('does not write to storage before cloud.message.queued arrives', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockImplementation(() => new Promise(() => {}));
      void mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
      });

      expect(atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList)).toHaveLength(0);
      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'Hello',
          mode: 'code',
          model: { providerID: 'kilo', modelID: 'claude-3-5-sonnet' },
        },
        images: undefined,
      });
    });

    it('sends only the explicit remote override and omits stale session model fields after clear', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const override = {
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      } as const;

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mgr.setRemoteModelOverride(override);
      mockSession.send.mockResolvedValue(undefined);

      await mgr.send({
        payload: {
          type: 'prompt',
          prompt: 'with override',
          mode: 'code',
          model: 'stale-session-model',
          variant: 'stale-session-variant',
        },
      });

      expect(mockSession.send).toHaveBeenLastCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'with override',
          mode: 'code',
          model: override.selection.model,
          variant: 'high',
        },
        remoteModelOverride: override,
        images: undefined,
      });

      mgr.setRemoteModelOverride(null);
      await mgr.send({
        payload: {
          type: 'prompt',
          prompt: 'without override',
          mode: 'code',
          model: 'stale-session-model',
          variant: 'stale-session-variant',
        },
      });

      expect(mockSession.send).toHaveBeenLastCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'without override',
          mode: 'code',
        },
        images: undefined,
      });
    });

    it('does not persist any optimistic message for remote sessions', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });

      mockSession.send.mockResolvedValue(undefined);
      await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
      });

      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code' },
        images: undefined,
      });
      expect(atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList)).toHaveLength(0);
    });

    it('leaves storage empty and sets error indicator + failedPrompt on failure', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockRejectedValue(new Error('ECONNREFUSED'));
      const accepted = await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
      });

      expect(accepted).toBe(false);
      expect(atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList)).toHaveLength(0);
      expect(atomValue<string | null>(config.store, mgr.atoms.failedPrompt)).toBe('Hello');
      const indicator = atomValue<{ type: string; message: string } | null>(
        config.store,
        mgr.atoms.statusIndicator
      );
      expect(indicator).toEqual(
        expect.objectContaining({
          type: 'error',
          message: 'Connection lost. Please retry in a moment.',
        })
      );
    });

    it('restores the prompt and explains how to recover from unavailable-model rejection', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockRejectedValue(
        Object.assign(new Error('Selected model is not available for this cloud agent session'), {
          data: { code: 'BAD_REQUEST', httpStatus: 400 },
        })
      );
      const accepted = await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'removed-model' },
      });

      expect(accepted).toBe(false);
      expect(atomValue<string | null>(config.store, mgr.atoms.failedPrompt)).toBe('Hello');
      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toEqual(
        expect.objectContaining({
          type: 'error',
          message:
            'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.',
        })
      );
    });

    it('calls onSendFailed with prompt on failure', async () => {
      const onSendFailed = jest.fn();
      const config = createMockConfig({ onSendFailed });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const error = new Error('fail');
      mockSession.send.mockRejectedValue(error);
      await mgr.send({
        payload: { type: 'prompt', prompt: 'My prompt', mode: 'code', model: 'claude-3-5-sonnet' },
      });

      expect(onSendFailed).toHaveBeenCalledWith(
        'My prompt',
        'Connection failed. Please retry in a moment.',
        error
      );
    });

    it('preserves disconnected status indicator when send fails after transport disconnect', async () => {
      const onSendFailed = jest.fn();
      const config = createMockConfig({ onSendFailed });
      const mgr = createSessionManager(config);

      mockSession.state.getStatus.mockReturnValue({ type: 'disconnected' });
      await mgr.switchSession(kiloId('ses-1'));

      expect(atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList)).toHaveLength(0);
      const disconnectedIndicator = atomValue<{ type: string; message: string } | null>(
        config.store,
        mgr.atoms.statusIndicator
      );
      expect(disconnectedIndicator).toEqual(
        expect.objectContaining({
          type: 'error',
          message: 'Agent connection lost',
        })
      );

      mockSession.send.mockRejectedValue(new Error('Transport disconnected'));
      const accepted = await mgr.send({
        payload: { type: 'prompt', prompt: 'My prompt', mode: 'code', model: 'claude-3-5-sonnet' },
      });

      expect(accepted).toBe(false);
      expect(onSendFailed).toHaveBeenCalledWith('My prompt', expect.any(String), expect.any(Error));
      expect(atomValue<string | null>(config.store, mgr.atoms.failedPrompt)).toBe('My prompt');
      expect(atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList)).toHaveLength(0);
      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toEqual(
        expect.objectContaining({
          type: 'error',
          message: 'Agent connection lost',
        })
      );
    });

    it('clears disconnected error and indicator after the transport reconnects', async () => {
      let notifyStateChange: (() => void) | undefined;
      mockSession.state.subscribe.mockImplementation(callback => {
        notifyStateChange = callback;
        callback();
        return () => {};
      });

      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.state.getStatus.mockReturnValue({ type: 'disconnected' });
      mockSessionCallbacks.onError?.('Connection to agent lost');
      notifyStateChange?.();

      expect(atomValue<string | null>(config.store, mgr.atoms.error)).toBe(
        'Connection to agent lost'
      );
      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toEqual(
        expect.objectContaining({
          type: 'error',
          message: 'Agent connection lost',
        })
      );

      mockSession.state.getStatus.mockReturnValue({ type: 'idle' });
      notifyStateChange?.();

      expect(atomValue<string | null>(config.store, mgr.atoms.error)).toBeNull();
      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toBeNull();
    });

    it('passes variant through to session.send', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockResolvedValue(undefined);
      await mgr.send({
        payload: {
          type: 'prompt',
          prompt: 'Hello',
          mode: 'code',
          model: 'claude-3-5-sonnet',
          variant: 'high',
        },
      });

      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'Hello',
          mode: 'code',
          model: { providerID: 'kilo', modelID: 'claude-3-5-sonnet' },
          variant: 'high',
        },
        images: undefined,
      });
    });

    it('passes images through to session.send for legacy Cloud Agent callers', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const images = { path: 'cloud-agent/message-1', files: ['image.png'] };

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockResolvedValue(undefined);
      const accepted = await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
        images,
      });

      expect(accepted).toBe(true);
      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'Hello',
          mode: 'code',
          model: { providerID: 'kilo', modelID: 'claude-3-5-sonnet' },
        },
        images,
      });
    });

    it('passes canonical document attachments through to session.send', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const attachments = {
        path: '12345678-1234-4234-9234-123456789abc',
        files: ['87654321-4321-4321-8321-cba987654321.md'],
      };

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockResolvedValue(undefined);
      const accepted = await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
        attachments,
      });

      expect(accepted).toBe(true);
      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'Hello',
          mode: 'code',
          model: { providerID: 'kilo', modelID: 'claude-3-5-sonnet' },
        },
        attachments,
        images: undefined,
      });
    });

    it('rejects canonical attachments for resolved remote sessions before transport send', async () => {
      const onSendFailed = jest.fn();
      const config = createMockConfig({ onSendFailed });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });

      const accepted = await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
        attachments: {
          path: '12345678-1234-4234-9234-123456789abc',
          files: ['87654321-4321-4321-8321-cba987654321.md'],
        },
      });

      expect(accepted).toBe(false);
      expect(mockSession.send).not.toHaveBeenCalled();
      expect(atomValue<string | null>(config.store, mgr.atoms.failedPrompt)).toBe('Hello');
      expect(onSendFailed).toHaveBeenCalledWith(
        'Hello',
        'Connection failed. Please retry in a moment.',
        expect.any(Error)
      );
    });

    it('rejects canonical attachments for resolved read-only sessions before transport send', async () => {
      const onSendFailed = jest.fn();
      const config = createMockConfig({ onSendFailed });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'read-only', kiloSessionId: kiloId('ses-1') });

      const accepted = await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
        attachments: {
          path: '12345678-1234-4234-9234-123456789abc',
          files: ['87654321-4321-4321-8321-cba987654321.md'],
        },
      });

      expect(accepted).toBe(false);
      expect(mockSession.send).not.toHaveBeenCalled();
      expect(atomValue<string | null>(config.store, mgr.atoms.failedPrompt)).toBe('Hello');
      expect(onSendFailed).toHaveBeenCalledWith(
        'Hello',
        'Connection failed. Please retry in a moment.',
        expect.any(Error)
      );
    });

    it('omits variant when not provided (backward compat)', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockResolvedValue(undefined);
      await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
      });

      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'Hello',
          mode: 'code',
          model: { providerID: 'kilo', modelID: 'claude-3-5-sonnet' },
        },
        images: undefined,
      });
    });

    it('without active session sets error indicator', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      // No switchSession — no active session
      const accepted = await mgr.send({
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
      });

      expect(accepted).toBe(false);
      const indicator = atomValue<{ type: string; message: string } | null>(
        config.store,
        mgr.atoms.statusIndicator
      );
      expect(indicator).toEqual(
        expect.objectContaining({
          type: 'error',
          message: 'Connection failed. Please retry in a moment.',
        })
      );
    });
  });

  describe('message filtering', () => {
    it('main chat excludes child messages even if child session.created never arrived', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const rootMessage = createStoredMessage('msg-root', 'ses-root', 'assistant');
      const childMessage = createStoredMessage('msg-child', 'child-1', 'assistant');

      mockSession.connect.mockImplementation(() => {
        const storage = mockSession.storage;
        if (!storage) throw new Error('expected session storage');
        storage.upsertMessage(rootMessage.info);
        storage.upsertMessage(childMessage.info);
        mockSessionCallbacks.onSessionCreated?.({ id: 'ses-root' });
      });

      await mgr.switchSession(kiloId('ses-root'));

      if (!latestStorage) throw new Error('expected session storage');
      latestStorage.upsertMessage(rootMessage.info);
      latestStorage.upsertMessage(childMessage.info);

      expect(atomValue(config.store, mgr.atoms.messagesList)).toEqual([rootMessage]);
      expect(atomValue(config.store, mgr.atoms.messagesList)).not.toContainEqual(childMessage);
    });

    it('main chat includes only root-session messages for the active kiloSessionId', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const activeRootMessage = createStoredMessage('msg-active', 'ses-active', 'user');
      const staleRootMessage = createStoredMessage('msg-stale', 'ses-other', 'assistant');
      const childMessage = createStoredMessage('msg-child', 'child-2', 'assistant');

      mockSession.connect.mockImplementation(() => {
        mockSessionCallbacks.onSessionCreated?.({ id: 'ses-active' });
      });

      await mgr.switchSession(kiloId('ses-active'));

      if (!latestStorage) throw new Error('expected session storage');

      latestStorage.upsertMessage(activeRootMessage.info);
      latestStorage.upsertMessage(staleRootMessage.info);
      latestStorage.upsertMessage(childMessage.info);

      expect(atomValue(config.store, mgr.atoms.messagesList)).toEqual([activeRootMessage]);
    });

    it('childMessages still returns only the requested child session messages', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const childOneFirst = createStoredMessage('msg-child-1a', 'child-1', 'assistant');
      const rootMessage = createStoredMessage('msg-root', 'ses-root', 'assistant');
      const childTwo = createStoredMessage('msg-child-2', 'child-2', 'assistant');
      const childOneSecond = createStoredMessage('msg-child-1b', 'child-1', 'user');

      mockSession.connect.mockImplementation(() => {
        mockSessionCallbacks.onSessionCreated?.({ id: 'ses-root' });
      });

      await mgr.switchSession(kiloId('ses-root'));

      if (!latestStorage) throw new Error('expected session storage');

      latestStorage.upsertMessage(childOneFirst.info);
      latestStorage.upsertMessage(rootMessage.info);
      latestStorage.upsertMessage(childTwo.info);
      latestStorage.upsertMessage(childOneSecond.info);

      const childMessages = atomValue<(childSessionId: string) => unknown[]>(
        config.store,
        mgr.atoms.childMessages
      );

      expect(childMessages('child-1')).toEqual([childOneFirst, childOneSecond]);
    });
  });

  describe('context usage', () => {
    it('exposes token footprint and runtime model identity from the root assistant response', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));
      if (!latestStorage) throw new Error('expected session storage');
      latestStorage.upsertMessage(createStoredAssistantMessage('msg-001', 'ses-root').info);

      expect(atomValue(config.store, mgr.atoms.contextUsage)).toEqual({
        contextTokens: 20,
        providerID: 'kilo',
        modelID: 'anthropic/claude-sonnet-4',
      });
    });

    it('replaces the metric with the latest eligible root assistant response', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));
      if (!latestStorage) throw new Error('expected session storage');
      latestStorage.upsertMessage(createStoredAssistantMessage('msg-001', 'ses-root').info);
      latestStorage.upsertMessage(
        createStoredAssistantMessage('msg-002', 'ses-root', {
          modelID: 'openai/gpt-5',
          tokens: { input: 20, output: 5, reasoning: 1, cache: { read: 2, write: 3 } },
        }).info
      );

      expect(atomValue(config.store, mgr.atoms.contextUsage)).toEqual({
        contextTokens: 31,
        providerID: 'kilo',
        modelID: 'openai/gpt-5',
      });
    });

    it('keeps the previous metric while the latest root assistant response has zero output', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));
      if (!latestStorage) throw new Error('expected session storage');
      latestStorage.upsertMessage(createStoredAssistantMessage('msg-001', 'ses-root').info);
      latestStorage.upsertMessage(
        createStoredAssistantMessage('msg-002', 'ses-root', {
          modelID: 'openai/gpt-5',
          tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }).info
      );

      expect(atomValue(config.store, mgr.atoms.contextUsage)).toEqual({
        contextTokens: 20,
        providerID: 'kilo',
        modelID: 'anthropic/claude-sonnet-4',
      });
    });

    it('ignores later child-session assistant responses', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));
      if (!latestStorage) throw new Error('expected session storage');
      latestStorage.upsertMessage(createStoredAssistantMessage('msg-001', 'ses-root').info);
      latestStorage.upsertMessage(
        createStoredAssistantMessage('msg-002', 'ses-child', {
          modelID: 'openai/gpt-5',
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        }).info
      );

      expect(atomValue(config.store, mgr.atoms.contextUsage)).toEqual({
        contextTokens: 20,
        providerID: 'kilo',
        modelID: 'anthropic/claude-sonnet-4',
      });
    });

    it('clears and replaces the metric when switching sessions', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));
      if (!latestStorage) throw new Error('expected session storage');
      latestStorage.upsertMessage(createStoredAssistantMessage('msg-001', 'ses-root').info);
      expect(atomValue(config.store, mgr.atoms.contextUsage)).toEqual({
        contextTokens: 20,
        providerID: 'kilo',
        modelID: 'anthropic/claude-sonnet-4',
      });

      await mgr.switchSession(kiloId('ses-next'));
      if (!latestStorage) throw new Error('expected session storage');
      expect(atomValue(config.store, mgr.atoms.contextUsage)).toBeUndefined();

      latestStorage.upsertMessage(
        createStoredAssistantMessage('msg-002', 'ses-next', {
          modelID: 'openai/gpt-5',
          tokens: { input: 40, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }).info
      );
      expect(atomValue(config.store, mgr.atoms.contextUsage)).toEqual({
        contextTokens: 50,
        providerID: 'kilo',
        modelID: 'openai/gpt-5',
      });
    });
  });

  describe('child session hydration', () => {
    it('hydrates child snapshots while preserving root transcript filtering', async () => {
      const rootMessage = createStoredMessage('msg-root', 'ses-root', 'assistant');
      const childMessage = createStoredMessage('msg-child-history', 'child-1', 'assistant');
      const childPart = stubTextPart({
        id: 'part-child-history',
        sessionID: 'child-1',
        messageID: childMessage.info.id,
        text: 'Historical child message',
      });
      const config = createMockConfig({
        fetchSnapshot: jest
          .fn()
          .mockResolvedValue(
            makeSnapshot({ id: 'child-1', parentID: 'ses-root' }, [
              { info: childMessage.info, parts: [childPart] },
            ])
          ),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));
      if (!latestStorage) throw new Error('expected session storage');
      latestStorage.upsertMessage(rootMessage.info);

      await mgr.hydrateChildSession(kiloId('child-1'));

      expect(config.fetchSnapshot).toHaveBeenCalledWith(kiloId('child-1'));
      const childMessages = atomValue<(childSessionId: string) => StoredMessage[]>(
        config.store,
        mgr.atoms.childMessages
      );
      expect(childMessages('child-1')).toEqual([{ info: childMessage.info, parts: [childPart] }]);
      expect(atomValue(config.store, mgr.atoms.messagesList)).toEqual([rootMessage]);
      const childHydrationState = atomValue<(childSessionId: string) => { status: string }>(
        config.store,
        mgr.atoms.childSessionHydrationState
      );
      expect(childHydrationState('child-1')).toEqual({ status: 'ready' });
    });

    it('merges fetched history into live child messages without duplicating them', async () => {
      const childMessage = createStoredMessage('msg-child-live', 'child-live', 'assistant');
      const livePart = stubTextPart({
        id: 'part-child-live',
        sessionID: 'child-live',
        messageID: childMessage.info.id,
        text: 'Partial live text',
      });
      const historicalPart = stubTextPart({
        ...livePart,
        text: 'Complete historical text',
      });
      const config = createMockConfig({
        fetchSnapshot: jest
          .fn()
          .mockResolvedValue(
            makeSnapshot({ id: 'child-live', parentID: 'ses-root' }, [
              { info: childMessage.info, parts: [historicalPart] },
            ])
          ),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));
      if (!latestStorage) throw new Error('expected session storage');
      latestStorage.upsertMessage(childMessage.info);
      latestStorage.upsertPart(childMessage.info.id, livePart);

      await mgr.hydrateChildSession(kiloId('child-live'));

      const childMessages = atomValue<(childSessionId: string) => StoredMessage[]>(
        config.store,
        mgr.atoms.childMessages
      );
      expect(childMessages('child-live')).toEqual([
        { info: childMessage.info, parts: [historicalPart] },
      ]);
    });

    it('deduplicates concurrent child snapshot hydration requests', async () => {
      let resolveSnapshot: ((snapshot: ReturnType<typeof makeSnapshot>) => void) | undefined;
      const childSnapshot = new Promise<ReturnType<typeof makeSnapshot>>(resolve => {
        resolveSnapshot = resolve;
      });
      const config = createMockConfig({
        fetchSnapshot: jest.fn().mockReturnValue(childSnapshot),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));

      const firstHydration = mgr.hydrateChildSession(kiloId('child-deduped'));
      const secondHydration = mgr.hydrateChildSession(kiloId('child-deduped'));

      expect(config.fetchSnapshot).toHaveBeenCalledTimes(1);
      const childHydrationState = atomValue<(childSessionId: string) => { status: string }>(
        config.store,
        mgr.atoms.childSessionHydrationState
      );
      expect(childHydrationState('child-deduped')).toEqual({ status: 'loading' });

      resolveSnapshot?.(makeSnapshot({ id: 'child-deduped', parentID: 'ses-root' }));
      await Promise.all([firstHydration, secondHydration]);

      const updatedChildHydrationState = atomValue<(childSessionId: string) => { status: string }>(
        config.store,
        mgr.atoms.childSessionHydrationState
      );
      expect(updatedChildHydrationState('child-deduped')).toEqual({ status: 'ready' });
    });

    it('ignores stale child snapshots after the active root session changes', async () => {
      let resolveSnapshot: ((snapshot: ReturnType<typeof makeSnapshot>) => void) | undefined;
      const childSnapshot = new Promise<ReturnType<typeof makeSnapshot>>(resolve => {
        resolveSnapshot = resolve;
      });
      const staleMessage = createStoredMessage('msg-child-stale', 'child-stale', 'assistant');
      const config = createMockConfig({
        fetchSnapshot: jest.fn().mockReturnValue(childSnapshot),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root-a'));
      const staleHydration = mgr.hydrateChildSession(kiloId('child-stale'));

      await mgr.switchSession(kiloId('ses-root-b'));
      resolveSnapshot?.(
        makeSnapshot({ id: 'child-stale', parentID: 'ses-root-a' }, [
          { info: staleMessage.info, parts: [] },
        ])
      );
      await staleHydration;

      const childMessages = atomValue<(childSessionId: string) => StoredMessage[]>(
        config.store,
        mgr.atoms.childMessages
      );
      expect(childMessages('child-stale')).toEqual([]);
      const childHydrationState = atomValue<(childSessionId: string) => { status: string }>(
        config.store,
        mgr.atoms.childSessionHydrationState
      );
      expect(childHydrationState('child-stale')).toEqual({ status: 'idle' });
    });

    it('allows retrying child history hydration after a snapshot fetch fails', async () => {
      const config = createMockConfig({
        fetchSnapshot: jest
          .fn()
          .mockRejectedValueOnce(new Error('fetch failed'))
          .mockResolvedValueOnce(makeSnapshot({ id: 'child-retry', parentID: 'ses-root' })),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-root'));
      await mgr.hydrateChildSession(kiloId('child-retry'));

      const childHydrationState = atomValue<
        (childSessionId: string) => { status: string; message?: string }
      >(config.store, mgr.atoms.childSessionHydrationState);
      expect(childHydrationState('child-retry')).toEqual(
        expect.objectContaining({ status: 'error' })
      );

      await mgr.hydrateChildSession(kiloId('child-retry'));

      expect(config.fetchSnapshot).toHaveBeenCalledTimes(2);
      const retriedChildHydrationState = atomValue<
        (childSessionId: string) => { status: string; message?: string }
      >(config.store, mgr.atoms.childSessionHydrationState);
      expect(retriedChildHydrationState('child-retry')).toEqual({ status: 'ready' });
    });
  });

  // -------------------------------------------------------------------------
  // sessionConfig variant tracking
  // -------------------------------------------------------------------------

  describe('sessionConfig variant tracking', () => {
    it('updates variant from assistant message events', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const mockedCreate = jest.mocked(createCloudAgentSession);

      await mgr.switchSession(kiloId('ses-1'));

      // The mock captures the session config — find the onEvent callback
      const sessionConfig = mockedCreate.mock.calls[0][0];

      // Simulate an assistant message with variant
      sessionConfig.onEvent?.({
        type: 'message.updated',
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'assistant',
          modelID: 'claude-3-5-sonnet',
          providerID: 'test',
          mode: 'code',
          variant: 'high',
          time: { created: 1 },
          agent: 'test',
          cost: 0,
          parentID: '',
          path: { cwd: '', root: '' },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      const sc = atomValue<{ variant?: string | null }>(config.store, mgr.atoms.sessionConfig);
      expect(sc?.variant).toBe('high');
    });

    it('sets variant to null when assistant message has no variant', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const mockedCreate = jest.mocked(createCloudAgentSession);

      await mgr.switchSession(kiloId('ses-1'));

      const sessionConfig = mockedCreate.mock.calls[0][0];

      sessionConfig.onEvent?.({
        type: 'message.updated',
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'assistant',
          modelID: 'claude-3-5-sonnet',
          providerID: 'test',
          mode: 'code',
          time: { created: 1 },
          agent: 'test',
          cost: 0,
          parentID: '',
          path: { cwd: '', root: '' },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      const sc = atomValue<{ variant?: string | null }>(config.store, mgr.atoms.sessionConfig);
      expect(sc?.variant).toBe(null);
    });

    it('ignores sessionConfig updates from child assistant messages', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const mockedCreate = jest.mocked(createCloudAgentSession);

      await mgr.switchSession(kiloId('ses-1'));

      const sessionConfig = mockedCreate.mock.calls[0][0];

      sessionConfig.onEvent?.({
        type: 'message.updated',
        info: {
          id: 'msg-child-1',
          sessionID: 'child-1',
          role: 'assistant',
          modelID: 'child-model',
          providerID: 'test',
          mode: 'primary',
          variant: 'high',
          time: { created: 1 },
          agent: 'child-agent',
          cost: 0,
          parentID: '',
          path: { cwd: '', root: '' },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      const sc = atomValue<{ model?: string; mode?: string; variant?: string | null }>(
        config.store,
        mgr.atoms.sessionConfig
      );
      expect(sc?.model).toBe('claude-3-5-sonnet');
      expect(sc?.mode).toBe('code');
      expect(sc?.variant).toBe(null);
    });

    it('updates sessionConfig.mode from assistant agent slug, not visibility mode', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const mockedCreate = jest.mocked(createCloudAgentSession);

      await mgr.switchSession(kiloId('ses-1'));

      const sessionConfig = mockedCreate.mock.calls[0][0];

      // Custom agents always carry `mode: 'primary' | 'subagent' | 'all'` as
      // visibility; the slug lives on `agent`. The picker must track the slug.
      sessionConfig.onEvent?.({
        type: 'message.updated',
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'assistant',
          modelID: 'claude-3-5-sonnet',
          providerID: 'test',
          mode: 'primary',
          time: { created: 1 },
          agent: 'e-code',
          cost: 0,
          parentID: '',
          path: { cwd: '', root: '' },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      const sc = atomValue<{ mode?: string }>(config.store, mgr.atoms.sessionConfig);
      expect(sc?.mode).toBe('e-code');
    });
  });

  // -------------------------------------------------------------------------
  // interrupt
  // -------------------------------------------------------------------------

  describe('interrupt', () => {
    it('calls session.interrupt and sets info indicator', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      await mgr.interrupt();

      expect(mockSession.interrupt).toHaveBeenCalledTimes(1);
      const indicator = atomValue<{ type: string; message: string } | null>(
        config.store,
        mgr.atoms.statusIndicator
      );
      expect(indicator).toEqual(
        expect.objectContaining({ type: 'info', message: 'Session stopped' })
      );
    });

    it('sets error on failure', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSession.interrupt.mockRejectedValueOnce(new Error('interrupt failed'));
      await mgr.interrupt();

      expect(atomValue<string | null>(config.store, mgr.atoms.error)).toBe(
        'Failed to stop execution'
      );
    });

    it('restores canSend and canInterrupt on interrupt failure', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      expect(atomValue<boolean>(config.store, mgr.atoms.canSend)).toBe(true);
      expect(atomValue<boolean>(config.store, mgr.atoms.canInterrupt)).toBe(true);

      mockSession.interrupt.mockRejectedValueOnce(new Error('transient failure'));
      await mgr.interrupt();

      // After a failed interrupt, atoms should be restored from session state
      expect(atomValue<boolean>(config.store, mgr.atoms.canSend)).toBe(true);
      expect(atomValue<boolean>(config.store, mgr.atoms.canInterrupt)).toBe(true);
    });

    it('is a no-op without active session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      // No switchSession
      await mgr.interrupt();

      expect(mockSession.interrupt).not.toHaveBeenCalled();
    });

    it('does NOT call session.disconnect after interrupt', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      await mgr.interrupt();

      expect(mockSession.disconnect).not.toHaveBeenCalled();
    });

    it('disables canSendAtom immediately on interrupt', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      // Verify canSend is true before interrupt
      expect(atomValue<boolean>(config.store, mgr.atoms.canSend)).toBe(true);

      // Call interrupt without awaiting — check synchronously after call
      void mgr.interrupt();
      // After calling interrupt (even before it resolves), canSend should be false
      expect(atomValue<boolean>(config.store, mgr.atoms.canSend)).toBe(false);
    });

    it('disables canInterruptAtom immediately on interrupt', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      expect(atomValue<boolean>(config.store, mgr.atoms.canInterrupt)).toBe(true);

      void mgr.interrupt();
      expect(atomValue<boolean>(config.store, mgr.atoms.canInterrupt)).toBe(false);
    });

    it('session remains usable after interrupt — send does not throw', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      await mgr.interrupt();

      // After interrupt, send should NOT throw — transport should still be alive
      mockSession.send.mockResolvedValue({});
      await expect(
        mgr.send({
          payload: {
            type: 'prompt',
            prompt: 'follow-up message',
            mode: 'code',
            model: 'claude-3-5-sonnet',
          },
        })
      ).resolves.not.toThrow();
      expect(mockSession.send).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // createAndStart
  // -------------------------------------------------------------------------

  describe('createAndStart', () => {
    it('calls prepare then initiate then switchSession', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const input = {
        prompt: 'Fix the bug',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        githubRepo: 'test/repo',
      };

      await mgr.createAndStart(input);

      expect(config.prepare).toHaveBeenCalledWith({
        ...input,
        initialMessageId: expect.stringMatching(/^msg_/),
      });
      const prepareMock = jest.mocked(config.prepare);
      const preparedInput = prepareMock.mock.calls[0]?.[0];
      expect(preparedInput?.initialMessageId).toEqual(expect.stringMatching(/^msg_/));
      expect(config.initiate).toHaveBeenCalledWith({
        cloudAgentSessionId: cloudAgentId('agent-new'),
      });
      expect(config.fetchSession).toHaveBeenCalledWith(kiloId('ses-new'));
    });

    it('adopts root session ID reported by session.created even if it differs', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.createAndStart({
        prompt: 'Fix the bug',
        mode: 'code',
        model: 'claude-3-5-sonnet',
      });

      // Simulate a session.created event that reports a different root
      // session ID than the one switchSession was called with.
      const realRootId = 'ses-real-root';
      mockSessionCallbacks.onSessionCreated?.({ id: realRootId });

      if (!latestStorage) throw new Error('expected session storage');
      const rootMessage = createStoredMessage('msg-1', realRootId, 'assistant');
      latestStorage.upsertMessage(rootMessage.info);

      expect(atomValue(config.store, mgr.atoms.messagesList)).toEqual([rootMessage]);
    });

    it('sets error indicator on prepare failure', async () => {
      const config = createMockConfig({
        prepare: jest.fn().mockRejectedValue({ data: { code: 'PAYMENT_REQUIRED' } }),
      });
      const mgr = createSessionManager(config);

      await mgr.createAndStart({
        prompt: 'Fix',
        mode: 'code',
        model: 'claude-3-5-sonnet',
      });

      const indicator = atomValue<{ type: string; message: string } | null>(
        config.store,
        mgr.atoms.statusIndicator
      );
      expect(indicator).toEqual(
        expect.objectContaining({
          type: 'error',
          message: 'Insufficient credits. Please add at least $1 to continue using Cloud Agent.',
        })
      );
      expect(config.initiate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // activeQuestion / activePermission
  // -------------------------------------------------------------------------

  describe('activeQuestion / activePermission', () => {
    it('onQuestionAsked sets activeQuestion', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      const questions = [
        {
          question: 'Pick a color',
          header: 'Color',
          options: [
            { label: 'Red', description: '' },
            { label: 'Blue', description: '' },
          ],
        },
      ];
      mockSessionCallbacks.onQuestionAsked?.('req-1', questions);
      expect(atomValue(config.store, mgr.atoms.activeQuestion)).toEqual({
        requestId: 'req-1',
        questions,
      });

      const questions2 = [{ question: 'Pick a shape', header: 'Shape', options: [] }];
      mockSessionCallbacks.onQuestionAsked?.('req-2', questions2);
      expect(atomValue(config.store, mgr.atoms.activeQuestion)).toEqual({
        requestId: 'req-2',
        questions: questions2,
      });
    });

    it('onQuestionResolved clears activeQuestion', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      const questions = [{ question: 'Pick one', header: 'Q', options: [] }];
      mockSessionCallbacks.onQuestionAsked?.('req-1', questions);
      expect(atomValue(config.store, mgr.atoms.activeQuestion)).not.toBeNull();

      mockSessionCallbacks.onQuestionResolved?.('req-1');
      expect(atomValue(config.store, mgr.atoms.activeQuestion)).toBeNull();
    });

    it('onPermissionAsked sets activePermission', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      mockSessionCallbacks.onPermissionAsked?.('req-1', 'write', ['*.ts'], {}, []);
      expect(atomValue(config.store, mgr.atoms.activePermission)).toEqual({
        requestId: 'req-1',
        permission: 'write',
        patterns: ['*.ts'],
        metadata: {},
        always: [],
      });

      mockSessionCallbacks.onPermissionAsked?.('req-2', 'bash', ['**'], { command: 'rm' }, [
        'write',
      ]);
      expect(atomValue(config.store, mgr.atoms.activePermission)).toEqual({
        requestId: 'req-2',
        permission: 'bash',
        patterns: ['**'],
        metadata: { command: 'rm' },
        always: ['write'],
      });
    });

    it('onPermissionResolved clears activePermission', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      mockSessionCallbacks.onPermissionAsked?.('req-1', 'write', [], {}, []);
      expect(atomValue(config.store, mgr.atoms.activePermission)).not.toBeNull();

      mockSessionCallbacks.onPermissionResolved?.('req-1');
      expect(atomValue(config.store, mgr.atoms.activePermission)).toBeNull();
    });

    it('onSuggestionAsked sets activeSuggestion with callId', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      const actions = [{ label: 'Review', prompt: '/local-review' }];
      mockSessionCallbacks.onSuggestionAsked?.('sug-1', 'Review?', actions, 'call-1');
      expect(atomValue(config.store, mgr.atoms.activeSuggestion)).toEqual({
        requestId: 'sug-1',
        text: 'Review?',
        actions,
        callId: 'call-1',
      });
    });

    it('onSuggestionResolved clears activeSuggestion', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      mockSessionCallbacks.onSuggestionAsked?.('sug-1', 'Review?', [], 'call-1');
      expect(atomValue(config.store, mgr.atoms.activeSuggestion)).not.toBeNull();

      mockSessionCallbacks.onSuggestionResolved?.('sug-1');
      expect(atomValue(config.store, mgr.atoms.activeSuggestion)).toBeNull();
    });

    it('acceptSuggestion forwards to session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      await mgr.acceptSuggestion('sug-1', 0);

      expect(mockSession.acceptSuggestion).toHaveBeenCalledWith({ requestId: 'sug-1', index: 0 });
    });

    it('dismissSuggestion forwards to session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      await mgr.dismissSuggestion('sug-2');

      expect(mockSession.dismissSuggestion).toHaveBeenCalledWith({ requestId: 'sug-2' });
    });

    it('destroy clears activeQuestion and activePermission', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      mockSessionCallbacks.onQuestionAsked?.('req-q', [
        { question: 'Q?', header: 'Q', options: [] },
      ]);
      mockSessionCallbacks.onPermissionAsked?.('req-p', 'write', [], {}, []);
      expect(atomValue(config.store, mgr.atoms.activeQuestion)).not.toBeNull();
      expect(atomValue(config.store, mgr.atoms.activePermission)).not.toBeNull();

      mgr.destroy();

      expect(atomValue(config.store, mgr.atoms.activeQuestion)).toBeNull();
      expect(atomValue(config.store, mgr.atoms.activePermission)).toBeNull();
    });

    it('switchSession clears activeQuestion and activePermission', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      mockSessionCallbacks.onQuestionAsked?.('req-q', [
        { question: 'Q?', header: 'Q', options: [] },
      ]);
      mockSessionCallbacks.onPermissionAsked?.('req-p', 'write', [], {}, []);
      expect(atomValue(config.store, mgr.atoms.activeQuestion)).not.toBeNull();
      expect(atomValue(config.store, mgr.atoms.activePermission)).not.toBeNull();

      await mgr.switchSession(kiloId('ses-2'));

      expect(atomValue(config.store, mgr.atoms.activeQuestion)).toBeNull();
      expect(atomValue(config.store, mgr.atoms.activePermission)).toBeNull();
    });

    it('switchSession clears availableCommands immediately', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      // Simulate a commands.available event from session A
      const mockedCreate = jest.mocked(createCloudAgentSession);
      const sessionConfig = mockedCreate.mock.calls[0][0];
      sessionConfig.onEvent?.({
        type: 'commands.available',
        commands: [{ name: 'review', description: 'Review code', hints: [] }],
      });
      expect(
        atomValue<{ name: string; description: string }[]>(
          config.store,
          mgr.atoms.availableCommands
        )
      ).toHaveLength(1);

      // Switch to session B — commands should be cleared before any new event arrives
      const switchPromise = mgr.switchSession(kiloId('ses-2'));
      expect(
        atomValue<{ name: string; description: string }[]>(
          config.store,
          mgr.atoms.availableCommands
        )
      ).toHaveLength(0);

      await switchPromise;
    });
  });

  // -------------------------------------------------------------------------
  // clearError / destroy
  // -------------------------------------------------------------------------

  describe('clearError', () => {
    it('resets error atom and status indicator', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      config.store.set(mgr.atoms.error, 'some error');
      config.store.set(mgr.atoms.statusIndicator, {
        type: 'error',
        message: 'some error',
        timestamp: Date.now(),
      });
      mgr.clearError();

      expect(atomValue<string | null>(config.store, mgr.atoms.error)).toBeNull();
      expect(
        atomValue<{ type: string; message: string } | null>(config.store, mgr.atoms.statusIndicator)
      ).toBeNull();
    });
  });

  describe('destroy', () => {
    it('clears all atoms and nulls activeSessionId', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      // Verify state is populated
      expect(atomValue<string | null>(config.store, mgr.atoms.sessionId)).toBe('agent-1');

      mgr.destroy();

      expect(atomValue<string | null>(config.store, mgr.atoms.sessionId)).toBeNull();
      expect(atomValue<boolean>(config.store, mgr.atoms.isLoading)).toBe(false);
      expect(atomValue<boolean>(config.store, mgr.atoms.isStreaming)).toBe(false);
      expect(atomValue<string | null>(config.store, mgr.atoms.error)).toBeNull();
      expect(atomValue<unknown>(config.store, mgr.atoms.sessionConfig)).toBeNull();

      // switchSession after destroy should still work (fresh state)
      await mgr.switchSession(kiloId('ses-2'));
      expect(atomValue<string | null>(config.store, mgr.atoms.sessionId)).toBe('agent-1');
    });
  });

  // -------------------------------------------------------------------------
  // pendingMessages atom
  // -------------------------------------------------------------------------

  describe('pendingMessages atom', () => {
    async function switchAndCaptureSubscriber(
      config: SessionManagerConfig,
      mgr: ReturnType<typeof createSessionManager>
    ): Promise<() => void> {
      let subscriberCallback: (() => void) | null = null;
      mockSession.state.subscribe.mockImplementation(callback => {
        subscriberCallback = callback;
        callback();
        return () => {};
      });
      await mgr.switchSession(kiloId('ses-1'));
      if (!subscriberCallback) {
        throw new Error('Expected service state subscription callback');
      }
      return subscriberCallback;
    }

    it('starts empty', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const pending = atomValue<ReadonlyMap<string, MessageDeliveryState>>(
        config.store,
        mgr.atoms.pendingMessages
      );
      expect(pending.size).toBe(0);
    });

    it('surfaces queued entries from service state', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const triggerSubscriber = await switchAndCaptureSubscriber(config, mgr);

      const queuedMap: ReadonlyMap<string, MessageDeliveryState> = new Map([
        ['m1', { status: 'queued' }],
      ]);
      mockSession.state.getPendingMessages.mockReturnValue(queuedMap);
      triggerSubscriber();

      const pending = atomValue<ReadonlyMap<string, MessageDeliveryState>>(
        config.store,
        mgr.atoms.pendingMessages
      );
      expect(pending.get('m1')).toEqual({ status: 'queued' });
    });

    it('clears entry when service state completes the message', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const triggerSubscriber = await switchAndCaptureSubscriber(config, mgr);

      mockSession.state.getPendingMessages.mockReturnValue(
        new Map<string, MessageDeliveryState>([['m1', { status: 'queued' }]])
      );
      triggerSubscriber();

      mockSession.state.getPendingMessages.mockReturnValue(new Map());
      triggerSubscriber();

      const pending = atomValue<ReadonlyMap<string, MessageDeliveryState>>(
        config.store,
        mgr.atoms.pendingMessages
      );
      expect(pending.has('m1')).toBe(false);
    });

    it('notifies subscribers when service state mutates the same pending map reference', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const pendingMap = new Map<string, MessageDeliveryState>();
      mockSession.state.getPendingMessages.mockReturnValue(pendingMap);

      const triggerSubscriber = await switchAndCaptureSubscriber(config, mgr);
      const snapshots: string[][] = [];
      const unsubscribe = config.store.sub(mgr.atoms.pendingMessages, () => {
        snapshots.push(
          Array.from(
            atomValue<ReadonlyMap<string, MessageDeliveryState>>(
              config.store,
              mgr.atoms.pendingMessages
            ).keys()
          )
        );
      });

      pendingMap.set('m1', { status: 'queued' });
      triggerSubscriber();
      pendingMap.delete('m1');
      triggerSubscriber();
      unsubscribe();

      expect(snapshots).toEqual([['m1'], []]);
    });

    it('leaves failedPromptAtom null when a queued message transitions', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const triggerSubscriber = await switchAndCaptureSubscriber(config, mgr);

      mockSession.state.getPendingMessages.mockReturnValue(
        new Map<string, MessageDeliveryState>([['m1', { status: 'queued' }]])
      );
      triggerSubscriber();

      mockSession.state.getPendingMessages.mockReturnValue(new Map());
      triggerSubscriber();

      expect(atomValue<string | null>(config.store, mgr.atoms.failedPrompt)).toBeNull();
    });

    it('clears pendingMessages on destroy', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      const triggerSubscriber = await switchAndCaptureSubscriber(config, mgr);

      mockSession.state.getPendingMessages.mockReturnValue(
        new Map<string, MessageDeliveryState>([['m1', { status: 'queued' }]])
      );
      triggerSubscriber();

      mgr.destroy();

      const pending = atomValue<ReadonlyMap<string, MessageDeliveryState>>(
        config.store,
        mgr.atoms.pendingMessages
      );
      expect(pending.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // createRemoteSession
  // -------------------------------------------------------------------------

  describe('createRemoteSession', () => {
    it('returns a branded KiloSessionId and leaves current session/atoms unchanged', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const newId = kiloId('ses_99999999999999999999999999');
      mockSession.createRemoteSession.mockResolvedValue(newId);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });

      const beforeSessionId = atomValue<string | null>(config.store, mgr.atoms.sessionId);
      const result = await mgr.createRemoteSession();

      expect(result).toBe(newId);
      expect(mockSession.createRemoteSession).toHaveBeenCalledTimes(1);
      expect(atomValue<string | null>(config.store, mgr.atoms.sessionId)).toBe(beforeSessionId);
    });

    it('rejects before traffic with a stable error when there is no active session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await expect(mgr.createRemoteSession()).rejects.toThrow(
        REMOTE_SESSION_CREATION_NOT_SUPPORTED
      );
      expect(mockSession.createRemoteSession).not.toHaveBeenCalled();
    });

    it('rejects before traffic with a stable error for a non-remote session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));
      // default mock resolves to cloud-agent
      await expect(mgr.createRemoteSession()).rejects.toThrow(
        REMOTE_SESSION_CREATION_NOT_SUPPORTED
      );
      expect(mockSession.createRemoteSession).not.toHaveBeenCalled();
    });

    it('rejects before traffic with a stable error when the transport lacks createSession capability', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSession.createRemoteSession.mockRejectedValue(
        new Error(REMOTE_SESSION_CREATION_NOT_SUPPORTED)
      );
      await expect(mgr.createRemoteSession()).rejects.toThrow(
        REMOTE_SESSION_CREATION_NOT_SUPPORTED
      );
    });
  });

  describe('exitRemoteCli', () => {
    it('forwards only for the active remote session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });

      await expect(mgr.exitRemoteCli()).resolves.toBeUndefined();
      expect(mockSession.exitRemoteCli).toHaveBeenCalledTimes(1);
    });

    it('rejects before forwarding when there is no active session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await expect(mgr.exitRemoteCli()).rejects.toThrow(REMOTE_CLI_EXIT_NOT_SUPPORTED);
      expect(mockSession.exitRemoteCli).not.toHaveBeenCalled();
    });

    it('rejects before forwarding for a non-remote session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));

      await expect(mgr.exitRemoteCli()).rejects.toThrow(REMOTE_CLI_EXIT_NOT_SUPPORTED);
      expect(mockSession.exitRemoteCli).not.toHaveBeenCalled();
    });

    it('propagates the session unsupported error when transport capability is absent', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSession.exitRemoteCli.mockRejectedValue(new Error(REMOTE_CLI_EXIT_NOT_SUPPORTED));

      await expect(mgr.exitRemoteCli()).rejects.toThrow(REMOTE_CLI_EXIT_NOT_SUPPORTED);
    });
  });

  // -------------------------------------------------------------------------
  // retryRemoteCommands
  // -------------------------------------------------------------------------

  describe('retryRemoteCommands', () => {
    it('delegates to the active session when a remote session is resolved', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mgr.retryRemoteCommands();
      expect(mockSession.retryRemoteCommands).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when there is no active session', () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      expect(() => mgr.retryRemoteCommands()).not.toThrow();
      expect(mockSession.retryRemoteCommands).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // remote command state atom
  // -------------------------------------------------------------------------

  describe('remote command state atom', () => {
    it('starts empty after resolving to a remote session', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      expect(atomValue(config.store, mgr.atoms.remoteCommandState)).toEqual({
        ownerConnectionId: null,
        refresh: 'idle',
        commands: [],
      });
    });

    it('updates when the remote command state callback fires', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));
      const nextState: RemoteCommandState = {
        ownerConnectionId: 'owner',
        refresh: 'idle',
        commands: [{ name: 'review', description: 'Review changes', hints: [] }],
      };
      mockSessionCallbacks.onRemoteCommandStateChange?.(nextState);
      expect(atomValue(config.store, mgr.atoms.remoteCommandState)).toEqual(nextState);
    });
  });

  // -------------------------------------------------------------------------
  // switchSession clears remote command state immediately
  // -------------------------------------------------------------------------

  describe('switchSession remote command state clearing', () => {
    it('clears availableCommands and remoteCommandState before the new fetch resolves', async () => {
      let resolveFetch: (val: FetchedSessionData) => void;
      const slowFetch = new Promise<FetchedSessionData>(resolve => {
        resolveFetch = resolve;
      });
      const config = createMockConfig({
        fetchSession: jest
          .fn()
          .mockResolvedValueOnce(defaultFetchedSession)
          .mockReturnValueOnce(slowFetch),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteCommandStateChange?.({
        ownerConnectionId: 'owner-a',
        refresh: 'idle',
        commands: [{ name: 'review', hints: [] }],
      });
      mockSessionCallbacks.onEvent?.({
        type: 'commands.available',
        commands: [{ name: 'review', hints: [] }],
      });
      expect(atomValue(config.store, mgr.atoms.remoteCommandState)).toEqual(
        expect.objectContaining({
          ownerConnectionId: 'owner-a',
          commands: [{ name: 'review', hints: [] }],
        })
      );
      expect(atomValue(config.store, mgr.atoms.availableCommands)).toHaveLength(1);

      const switchPromise = mgr.switchSession(kiloId('ses-2'));
      expect(atomValue(config.store, mgr.atoms.remoteCommandState)).toEqual({
        ownerConnectionId: null,
        refresh: 'idle',
        commands: [],
      });
      expect(atomValue(config.store, mgr.atoms.availableCommands)).toHaveLength(0);

      resolveFetch!(defaultFetchedSession);
      await switchPromise;
    });
  });

  // -------------------------------------------------------------------------
  // generation gating for remote command callbacks
  // -------------------------------------------------------------------------

  describe('generation gating for remote command callbacks', () => {
    it('ignores late callbacks from a previous session after a new switch begins', async () => {
      let resolveFetch: (val: FetchedSessionData) => void;
      const slowFetch = new Promise<FetchedSessionData>(resolve => {
        resolveFetch = resolve;
      });
      const config = createMockConfig({
        fetchSession: jest
          .fn()
          .mockResolvedValueOnce(defaultFetchedSession)
          .mockReturnValueOnce(slowFetch),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      const firstCallbacks = { ...mockSessionCallbacks };
      firstCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      firstCallbacks.onRemoteCommandStateChange?.({
        ownerConnectionId: 'owner-a',
        refresh: 'idle',
        commands: [{ name: 'review', hints: [] }],
      });
      firstCallbacks.onEvent?.({
        type: 'commands.available',
        commands: [{ name: 'review', hints: [] }],
      });

      const switchPromise = mgr.switchSession(kiloId('ses-2'));
      firstCallbacks.onRemoteCommandStateChange?.({
        ownerConnectionId: 'stale-owner',
        refresh: 'idle',
        commands: [{ name: 'stale', hints: [] }],
      });
      firstCallbacks.onEvent?.({
        type: 'commands.available',
        commands: [{ name: 'stale', hints: [] }],
      });
      expect(atomValue(config.store, mgr.atoms.remoteCommandState)).toEqual({
        ownerConnectionId: null,
        refresh: 'idle',
        commands: [],
      });
      expect(atomValue(config.store, mgr.atoms.availableCommands)).toHaveLength(0);

      resolveFetch!(defaultFetchedSession);
      await switchPromise;

      // New session callbacks can still update state.
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-2') });
      mockSessionCallbacks.onRemoteCommandStateChange?.({
        ownerConnectionId: 'owner-b',
        refresh: 'idle',
        commands: [{ name: 'new', hints: [] }],
      });
      expect(atomValue(config.store, mgr.atoms.remoteCommandState)).toEqual({
        ownerConnectionId: 'owner-b',
        refresh: 'idle',
        commands: [{ name: 'new', hints: [] }],
      });
    });
  });

  // -------------------------------------------------------------------------
  // destroy + late callback suppression
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('clears remote command state and availableCommands and ignores late callbacks', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      await mgr.switchSession(kiloId('ses-1'));
      const firstCallbacks = { ...mockSessionCallbacks };
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });
      mockSessionCallbacks.onRemoteCommandStateChange?.({
        ownerConnectionId: 'owner-a',
        refresh: 'idle',
        commands: [{ name: 'review', hints: [] }],
      });
      mockSessionCallbacks.onEvent?.({
        type: 'commands.available',
        commands: [{ name: 'review', hints: [] }],
      });
      expect(
        atomValue<RemoteCommandState>(config.store, mgr.atoms.remoteCommandState).commands
      ).toHaveLength(1);
      expect(atomValue(config.store, mgr.atoms.availableCommands)).toHaveLength(1);

      mgr.destroy();
      expect(atomValue(config.store, mgr.atoms.remoteCommandState)).toEqual({
        ownerConnectionId: null,
        refresh: 'idle',
        commands: [],
      });
      expect(atomValue(config.store, mgr.atoms.availableCommands)).toHaveLength(0);

      firstCallbacks.onRemoteCommandStateChange?.({
        ownerConnectionId: 'stale',
        refresh: 'idle',
        commands: [{ name: 'stale', hints: [] }],
      });
      firstCallbacks.onEvent?.({
        type: 'commands.available',
        commands: [{ name: 'stale', hints: [] }],
      });
      expect(atomValue(config.store, mgr.atoms.remoteCommandState)).toEqual({
        ownerConnectionId: null,
        refresh: 'idle',
        commands: [],
      });
      expect(atomValue(config.store, mgr.atoms.availableCommands)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // clearAllAtoms behavior
  // -------------------------------------------------------------------------

  describe('clearAllAtoms', () => {
    it('resets session atoms without touching unrelated store atoms', () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const externalAtom = atom(42);
      config.store.set(externalAtom, 99);
      config.store.set(mgr.atoms.chatUI, { shouldAutoScroll: false });

      mgr.destroy();

      expect(atomValue(config.store, externalAtom)).toBe(99);
      expect(atomValue(config.store, mgr.atoms.chatUI)).toEqual({ shouldAutoScroll: true });
    });
  });
  // -------------------------------------------------------------------------
  // delivery failure status indicator
  // -------------------------------------------------------------------------

  describe('delivery failure status indicator', () => {
    it('exhausted-retry failure sets an error indicator and leaves failedPrompt null', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSessionCallbacks.onMessageFailed?.('m1', {
        status: 'failed',
        error: 'Pending queued message interrupted by user',
        reason: 'interrupted',
      });

      const indicator = atomValue<{ type: string; message: string } | null>(
        config.store,
        mgr.atoms.statusIndicator
      );
      expect(indicator).toEqual(
        expect.objectContaining({ type: 'error', message: 'Queued message interrupted' })
      );
    });

    it('execution failure does not overwrite the indicator', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const before = atomValue<unknown>(config.store, mgr.atoms.statusIndicator);

      mockSessionCallbacks.onMessageFailed?.('m1', {
        status: 'failed',
        error: 'boom',
        reason: 'execution',
      });

      expect(atomValue<unknown>(config.store, mgr.atoms.statusIndicator)).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// formatError (exported utility)
// ---------------------------------------------------------------------------

describe('formatError', () => {
  it('handles Error instances with ECONNREFUSED', () => {
    expect(formatError(new Error('ECONNREFUSED'))).toBe(
      'Connection lost. Please retry in a moment.'
    );
  });

  it('handles Error instances with fetch failed', () => {
    expect(formatError(new Error('fetch failed: network error'))).toBe(
      'Connection lost. Please retry in a moment.'
    );
  });

  it('handles generic Error instances', () => {
    expect(formatError(new Error('something else'))).toBe(
      'Connection failed. Please retry in a moment.'
    );
  });

  it('handles tRPC-like errors with PAYMENT_REQUIRED code', () => {
    expect(formatError({ data: { code: 'PAYMENT_REQUIRED' } })).toBe(
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.'
    );
  });

  it('handles tRPC-like errors with 402 httpStatus', () => {
    expect(formatError({ data: { httpStatus: 402 } })).toBe(
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.'
    );
  });

  it('handles UNAUTHORIZED code', () => {
    expect(formatError({ data: { code: 'UNAUTHORIZED' } })).toBe(
      'You are not authorized to use the Cloud Agent.'
    );
  });

  it('handles FORBIDDEN code', () => {
    expect(formatError({ data: { code: 'FORBIDDEN' } })).toBe(
      'You are not authorized to use the Cloud Agent.'
    );
  });

  it('handles NOT_FOUND code', () => {
    expect(formatError({ data: { code: 'NOT_FOUND' } })).toBe(
      'Service is unavailable right now. Please try again.'
    );
  });

  it('handles CONFLICT code', () => {
    expect(formatError({ data: { code: 'CONFLICT' } })).toBe(
      'Previous task is still finishing up. Please wait a moment.'
    );
  });

  it('handles 409 httpStatus', () => {
    expect(formatError({ data: { httpStatus: 409 } })).toBe(
      'Previous task is still finishing up. Please wait a moment.'
    );
  });

  it('handles shape-nested codes (alternative tRPC format)', () => {
    expect(formatError({ data: {}, shape: { code: 'PAYMENT_REQUIRED' } })).toBe(
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.'
    );
  });

  it('handles unknown object errors with data property', () => {
    expect(formatError({ data: { code: 'SOME_UNKNOWN_CODE' } })).toBe(
      'Something went wrong. Please retry in a moment.'
    );
  });

  it('handles SERVICE_UNAVAILABLE code', () => {
    expect(formatError({ data: { code: 'SERVICE_UNAVAILABLE' } })).toBe(
      'Service is temporarily unavailable. Please retry in a moment.'
    );
  });

  it('handles 503 httpStatus', () => {
    expect(formatError({ data: { httpStatus: 503 } })).toBe(
      'Service is temporarily unavailable. Please retry in a moment.'
    );
  });

  it('handles TRPCClientError-shaped Error instance with CONFLICT code', () => {
    const err = Object.assign(new Error('Execution exc_123 is in progress'), {
      data: { code: 'CONFLICT', httpStatus: 409 },
    });
    expect(formatError(err)).toBe('Previous task is still finishing up. Please wait a moment.');
  });

  it('handles TRPCClientError-shaped Error instance with 402 httpStatus', () => {
    const err = Object.assign(new Error('Payment required'), {
      data: { httpStatus: 402 },
    });
    expect(formatError(err)).toBe(
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.'
    );
  });

  it('handles TRPCClientError-shaped Error instance with SERVICE_UNAVAILABLE', () => {
    const err = Object.assign(new Error('upstream handshake failed'), {
      data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 },
    });
    expect(formatError(err)).toBe('Service is temporarily unavailable. Please retry in a moment.');
  });

  it('explains how to recover when the selected model is unavailable', () => {
    const err = Object.assign(
      new Error('SELECTED MODEL IS NOT AVAILABLE FOR THIS CLOUD AGENT SESSION'),
      {
        data: { code: 'BAD_REQUEST', httpStatus: 400 },
      }
    );
    expect(formatError(err)).toBe(
      'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.'
    );
  });

  it('handles wrapped unavailable-model errors', () => {
    const err = new Error(
      'prepareSession failed (400): {"error":{"message":"Selected model is not available for this cloud agent session"}}'
    );
    expect(formatError(err)).toBe(
      'Selected model is unavailable for Cloud Agent. Choose another available model or select a different agent, then try again.'
    );
  });

  it('keeps unrelated BAD_REQUEST errors generic', () => {
    const err = Object.assign(new Error('Some unrelated validation failure'), {
      data: { code: 'BAD_REQUEST', httpStatus: 400 },
    });
    expect(formatError(err)).toBe('Something went wrong. Please retry in a moment.');
  });

  it('handles TRPCClientError-shaped Error instance with unmapped code', () => {
    const err = Object.assign(new Error('boom'), {
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
    });
    expect(formatError(err)).toBe('Something went wrong. Please retry in a moment.');
  });

  it('handles unknown errors', () => {
    expect(formatError('just a string')).toBe('Something went wrong. Please retry in a moment.');
    expect(formatError(null)).toBe('Something went wrong. Please retry in a moment.');
    expect(formatError(42)).toBe('Something went wrong. Please retry in a moment.');
  });
});

describe('cliModelLabel', () => {
  it.each([
    [null, 'CLI default'],
    [{ model: 'claude-3-5-sonnet', providerID: null }, 'CLI model — claude-3-5-sonnet'],
    [
      { model: 'claude-3-5-sonnet', providerID: 'anthropic' },
      'CLI model — anthropic/claude-3-5-sonnet',
    ],
  ])('formats %p as %s', (config, expected) => {
    expect(cliModelLabel(config)).toBe(expected);
  });
});

describe('isReadOnly during connecting phase', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockSession.connect.mockClear();
    mockSession.disconnect.mockClear();
    mockSession.destroy.mockClear();
    mockSession.send.mockClear();
    mockSession.interrupt.mockClear();
    mockSession.respondToPermission.mockClear();
    mockSession.canSend = true;
    mockSession.canInterrupt = true;
    mockSession.state.subscribe.mockImplementation(callback => {
      callback();
      return () => {};
    });
    mockSession.storage = latestStorage;
    latestStorage = null;
    mockSessionCallbacks.onSessionCreated = undefined;
    mockSessionCallbacks.onSessionUpdated = undefined;
    mockSessionCallbacks.onQuestionAsked = undefined;
    mockSessionCallbacks.onQuestionResolved = undefined;
    mockSessionCallbacks.onPermissionAsked = undefined;
    mockSessionCallbacks.onPermissionResolved = undefined;
    mockSessionCallbacks.onResolved = undefined;
  });

  it('does not flash isReadOnly=true when subscriber fires during connecting with canSend=false', async () => {
    // Simulate the real behavior: when the session is first created, the
    // transport hasn't been resolved yet so canSend is false, and the
    // initial activity is 'connecting'. The state subscriber fires during
    // connect(), and without the guard this would set isReadOnly=true,
    // causing a brief "read-only session" flash in the UI.
    const subscriberCallbackRef: { current: (() => void) | null } = { current: null };

    mockSession.canSend = false;
    mockSession.state.getActivity.mockReturnValue({ type: 'connecting' as const });

    mockSession.state.subscribe.mockImplementation((callback: () => void) => {
      subscriberCallbackRef.current = callback;
      // Fire immediately to simulate the synchronous subscription trigger
      callback();
      return () => {};
    });

    mockSession.connect.mockImplementation(() => {
      // connect() triggers a state change while still connecting
      subscriberCallbackRef.current?.();
    });

    const config = createMockConfig();
    const mgr = createSessionManager(config);
    await mgr.switchSession(kiloId('ses-1'));

    // During the 'connecting' phase with canSend=false, isReadOnly must stay false
    expect(atomValue<boolean>(config.store, mgr.atoms.isReadOnly)).toBe(false);

    // Now simulate the transport resolving: activity becomes 'idle', canSend becomes true
    mockSession.canSend = true;
    mockSession.state.getActivity.mockReturnValue({ type: 'idle' as const });
    subscriberCallbackRef.current?.();

    expect(atomValue<boolean>(config.store, mgr.atoms.isReadOnly)).toBe(false);
  });

  it('sets isReadOnly=true for genuinely read-only sessions after connecting', async () => {
    // For read-only sessions (e.g. historical CLI sessions), after the
    // transport resolves the activity transitions past 'connecting' but
    // canSend remains false. isReadOnly should correctly become true.
    const subscriberCallbackRef: { current: (() => void) | null } = { current: null };

    mockSession.canSend = false;
    mockSession.state.getActivity.mockReturnValue({ type: 'connecting' as const });

    mockSession.state.subscribe.mockImplementation((callback: () => void) => {
      subscriberCallbackRef.current = callback;
      callback();
      return () => {};
    });

    mockSession.connect.mockImplementation(() => {
      subscriberCallbackRef.current?.();
    });

    const config = createMockConfig();
    const mgr = createSessionManager(config);
    await mgr.switchSession(kiloId('ses-1'));

    // Still connecting — isReadOnly should be false
    expect(atomValue<boolean>(config.store, mgr.atoms.isReadOnly)).toBe(false);

    // Transport resolves but canSend stays false (read-only session)
    mockSessionCallbacks.onResolved?.({ type: 'read-only', kiloSessionId: kiloId('ses-1') });
    mockSession.state.getActivity.mockReturnValue({ type: 'idle' as const });
    subscriberCallbackRef.current?.();

    expect(atomValue<boolean>(config.store, mgr.atoms.isReadOnly)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bounded initial snapshot + loadOlderMessages
// ---------------------------------------------------------------------------

type SessionSnapshotPageFetch = NonNullable<SessionManagerConfig['fetchSnapshotPage']>;

function makePageMessage(
  id: string,
  sessionID: string,
  text: string
): SessionSnapshotPage['messages'][number] {
  return {
    info: stubUserMessage({ id, sessionID }),
    parts: [stubTextPart({ id: `${id}-text`, sessionID, messageID: id, text })],
  };
}

function makePage(
  options: {
    kiloSessionId?: string;
    messages?: SessionSnapshotPage['messages'];
    nextCursor?: string | null;
    omittedItemCount?: number;
  } = {}
): SessionSnapshotPageOutcome {
  return {
    kind: 'success',
    info: { id: options.kiloSessionId ?? 'ses-1' },
    messages: options.messages ?? [],
    nextCursor: options.nextCursor ?? null,
    omittedItemCount: options.omittedItemCount ?? 0,
  };
}

function createPageFetchMock(
  impl: SessionSnapshotPageFetch
): jest.MockedFunction<SessionSnapshotPageFetch> {
  return jest.fn(impl) as jest.MockedFunction<SessionSnapshotPageFetch>;
}

describe('createSessionManager — paginated initial snapshot + loadOlderMessages', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockSession.connect.mockClear();
    mockSession.disconnect.mockClear();
    mockSession.destroy.mockClear();
    mockSession.send.mockClear();
    mockSession.interrupt.mockClear();
    mockSession.respondToPermission.mockClear();
    mockSession.canSend = true;
    mockSession.canInterrupt = true;
    mockSession.state.subscribe.mockImplementation(callback => {
      callback();
      return () => {};
    });
    mockSession.state.getStatus.mockReturnValue({ type: 'idle' });
    mockSession.state.getCloudStatus.mockReturnValue(null);
    mockSession.state.getPendingMessages.mockReturnValue(new Map());
    mockSession.storage = latestStorage;
    latestStorage = null;
    mockSessionCallbacks.onSessionCreated = undefined;
    mockSessionCallbacks.onSessionUpdated = undefined;
    mockSessionCallbacks.onQuestionAsked = undefined;
    mockSessionCallbacks.onQuestionResolved = undefined;
    mockSessionCallbacks.onPermissionAsked = undefined;
    mockSessionCallbacks.onPermissionResolved = undefined;
    mockSessionCallbacks.onResolved = undefined;
  });

  it('loads the initial bounded page on switchSession and stores the cursor', async () => {
    const fetchSnapshotPage = createPageFetchMock(async () =>
      makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A', omittedItemCount: 2 })
    );

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));

    expect(fetchSnapshotPage).toHaveBeenCalledWith('ses-1', {});
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(true);
    expect(atomValue<number>(config.store, mgr.atoms.olderMessagesOmittedItemCount)).toBe(2);
  });

  it('does not set hasOlderMessages when the initial page has no cursor', async () => {
    const fetchSnapshotPage = createPageFetchMock(async () =>
      makePage({ kiloSessionId: 'ses-1', nextCursor: null })
    );

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));

    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(false);
  });

  it('loadOlderMessages fetches the next page with the stored cursor and merges messages', async () => {
    const callArgs: Array<{ cursor?: string }> = [];
    const fetchSnapshotPage = createPageFetchMock(async (_id, options) => {
      callArgs.push({ ...options });
      if (!options.cursor) {
        return makePage({
          kiloSessionId: 'ses-1',
          messages: [makePageMessage('msg-2', 'ses-1', 'newer')],
          nextCursor: 'cursor-A',
        });
      }
      if (options.cursor === 'cursor-A') {
        return makePage({
          kiloSessionId: 'ses-1',
          messages: [makePageMessage('msg-1', 'ses-1', 'older')],
          nextCursor: null,
          omittedItemCount: 3,
        });
      }
      return makePage({ kiloSessionId: 'ses-1' });
    });

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(true);

    await mgr.loadOlderMessages();
    expect(callArgs).toEqual([{}, { cursor: 'cursor-A' }]);
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(false);
    expect(atomValue<number>(config.store, mgr.atoms.olderMessagesOmittedItemCount)).toBe(3);
    expect(
      atomValue<{ kind: string } | null>(config.store, mgr.atoms.olderMessagesError)
    ).toBeNull();

    const messages = atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList);
    expect(messages.map(m => m.info.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('loadOlderMessages is a no-op when there is no cursor', async () => {
    const fetchSnapshotPage = createPageFetchMock(async () =>
      makePage({ kiloSessionId: 'ses-1', nextCursor: null })
    );

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));
    await mgr.loadOlderMessages();

    // Only the initial call
    expect(fetchSnapshotPage).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent loadOlderMessages calls', async () => {
    let resolvePage: (value: SessionSnapshotPageOutcome) => void = () => undefined;
    const slowPage = new Promise<SessionSnapshotPageOutcome>(resolve => {
      resolvePage = resolve;
    });

    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }))
      .mockReturnValueOnce(slowPage);

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));

    const first = mgr.loadOlderMessages();
    const second = mgr.loadOlderMessages();

    resolvePage(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-B' }));

    await Promise.all([first, second]);

    expect(fetchSnapshotPage.mock.calls).toHaveLength(2);
  });

  it('does not run loadOlderMessages again after a switchSession', async () => {
    // Set up the slow promise and the one-time mocks in the order the
    // session-manager will consume them: initial → older load → next initial.
    let resolvePage: (value: SessionSnapshotPageOutcome) => void = () => undefined;
    const slowPage = new Promise<SessionSnapshotPageOutcome>(resolve => {
      resolvePage = resolve;
    });
    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }))
      .mockReturnValueOnce(slowPage)
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-2', nextCursor: null }))
      .mockResolvedValue(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }));

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));

    // Start loadOlder, but switch before it resolves.
    const older = mgr.loadOlderMessages();
    const switching = mgr.switchSession(kiloId('ses-2'));
    resolvePage(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-B' }));
    await Promise.all([older, switching]);

    // After the switch, hasOlderMessages reflects the new session (no cursor).
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(false);
  });

  it('surfaces retryable_failure on initial load via the standard error atom', async () => {
    const fetchSnapshotPage = createPageFetchMock(async () => ({
      kind: 'retryable_failure' as const,
    }));

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));

    expect(atomValue<string | null>(config.store, mgr.atoms.error)).not.toBeNull();
    expect(
      atomValue<{ kind: string } | null>(config.store, mgr.atoms.olderMessagesError)
    ).toBeNull();
  });

  it('surfaces non-retryable failure on initial load and disables further older loads', async () => {
    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce({ kind: 'too_large' as const })
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }));

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));

    expect(atomValue<string | null>(config.store, mgr.atoms.error)).not.toBeNull();
    // No cursor was set, so hasOlderMessages must remain false and the
    // backend must not be hit again.
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(false);
    await mgr.loadOlderMessages();
    expect(fetchSnapshotPage.mock.calls).toHaveLength(1);
  });

  it('keeps existing messages and exposes retryable older error when loadOlderMessages fails retryably', async () => {
    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }))
      .mockResolvedValueOnce({ kind: 'retryable_failure' as const });

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));
    const messageCountBefore = atomValue<StoredMessage[]>(
      config.store,
      mgr.atoms.messagesList
    ).length;
    expect(messageCountBefore).toBe(0);

    await mgr.loadOlderMessages();

    expect(atomValue<{ kind: string } | null>(config.store, mgr.atoms.olderMessagesError)).toEqual({
      kind: 'retryable',
    });
    // Cursor must remain so a retry can pick it up.
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(true);
    expect(fetchSnapshotPage).toHaveBeenLastCalledWith('ses-1', { cursor: 'cursor-A' });

    // Retryable retry — backend should be hit again and succeed.
    fetchSnapshotPage.mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: null }));
    await mgr.loadOlderMessages();

    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(false);
    expect(
      atomValue<{ kind: string } | null>(config.store, mgr.atoms.olderMessagesError)
    ).toBeNull();
  });

  it('treats a null older page outcome as terminal invalid_data and stops hitting the backend', async () => {
    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(makePage({ kiloSessionId: 'ses-1', nextCursor: null }));

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));
    await mgr.loadOlderMessages();

    expect(atomValue<{ kind: string } | null>(config.store, mgr.atoms.olderMessagesError)).toEqual({
      kind: 'invalid_data',
    });
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(false);

    // A second call should be a no-op (no backend hit).
    await mgr.loadOlderMessages();
    expect(fetchSnapshotPage).toHaveBeenCalledTimes(2);
  });

  it('rejects an older page whose session id does not match the active session', async () => {
    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }))
      .mockResolvedValueOnce(
        makePage({
          kiloSessionId: 'ses-other',
          messages: [makePageMessage('msg-other', 'ses-1', 'other')],
          nextCursor: null,
          omittedItemCount: 5,
        })
      );

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));
    await mgr.loadOlderMessages();

    const messages = atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList);
    expect(messages.map(m => m.info.id)).not.toContain('msg-other');
    // The cursor must stay at the previously known value so a later valid page can continue.
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(true);
    expect(atomValue<number>(config.store, mgr.atoms.olderMessagesOmittedItemCount)).toBe(0);
    expect(
      atomValue<{ kind: string } | null>(config.store, mgr.atoms.olderMessagesError)
    ).toBeNull();
  });

  it('marks non-retryable older failures as terminal and stops hitting the backend', async () => {
    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }))
      .mockResolvedValueOnce({ kind: 'invalid_data' as const })
      .mockResolvedValue(makePage({ kiloSessionId: 'ses-1', nextCursor: null }));

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));
    await mgr.loadOlderMessages();

    expect(atomValue<{ kind: string } | null>(config.store, mgr.atoms.olderMessagesError)).toEqual({
      kind: 'invalid_data',
    });
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(false);

    // A second call should be a no-op (no backend hit).
    await mgr.loadOlderMessages();
    expect(fetchSnapshotPage.mock.calls).toHaveLength(2);
  });

  it('advances the cursor on an empty older page with a non-null continuation', async () => {
    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }))
      .mockResolvedValueOnce(
        makePage({ kiloSessionId: 'ses-1', messages: [], nextCursor: 'cursor-B' })
      )
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: null }));

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(true);

    await mgr.loadOlderMessages();
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(true);

    await mgr.loadOlderMessages();
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(false);

    // The empty-with-cursor page must not have caused an infinite loop — we
    // made forward progress (3 calls total: initial, empty, final).
    expect(fetchSnapshotPage.mock.calls).toHaveLength(3);
  });

  it('exposes isLoadingOlderMessages while a load is in flight', async () => {
    let resolvePage: (value: SessionSnapshotPageOutcome) => void = () => undefined;
    const slowPage = new Promise<SessionSnapshotPageOutcome>(resolve => {
      resolvePage = resolve;
    });

    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage
      .mockResolvedValueOnce(makePage({ kiloSessionId: 'ses-1', nextCursor: 'cursor-A' }))
      .mockReturnValueOnce(slowPage);

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    await mgr.switchSession(kiloId('ses-1'));

    const loading = mgr.loadOlderMessages();
    expect(atomValue<boolean>(config.store, mgr.atoms.isLoadingOlderMessages)).toBe(true);

    resolvePage(makePage({ kiloSessionId: 'ses-1', nextCursor: null }));
    await loading;

    expect(atomValue<boolean>(config.store, mgr.atoms.isLoadingOlderMessages)).toBe(false);
  });

  it('does not let a late initial page from an earlier switchSession clobber the active session when both target the same session id', async () => {
    // Regression: the initial-page callback used to read `loadOlderGeneration`
    // at invocation time. A second `switchSession` to the same session id
    // advances the generation in `clearAllAtoms()` before the first
    // switch's `onInitialPageLoaded` callback runs, so the stale page
    // passed the generation check (equal to the new generation) and
    // overwrote the active session's cursor / messages / omitted-item
    // count. The fix captures the generation synchronously when the
    // callback is created.
    let resolveFirstPage: (value: SessionSnapshotPageOutcome) => void = () => undefined;
    const firstPagePromise = new Promise<SessionSnapshotPageOutcome>(resolve => {
      resolveFirstPage = resolve;
    });
    const fetchSnapshotPage = jest.fn() as jest.MockedFunction<SessionSnapshotPageFetch>;
    fetchSnapshotPage.mockReturnValueOnce(firstPagePromise).mockResolvedValueOnce(
      makePage({
        kiloSessionId: 'ses-1',
        nextCursor: 'current-cursor',
        messages: [makePageMessage('msg-current', 'ses-1', 'current')],
        omittedItemCount: 0,
      })
    );

    const config = createMockConfig({ fetchSnapshotPage });
    const mgr = createSessionManager(config);

    // Wait for the first switchSession to fully set up: the first
    // session.connect() must have kicked off the slow fetchSnapshotPage
    // and wired its `onInitialPageLoaded` callback before the second
    // switchSession advances `switchGeneration` and tears the first
    // switchSession's setup down.
    const first = mgr.switchSession(kiloId('ses-1'));
    await first;

    const second = mgr.switchSession(kiloId('ses-1'));
    await second;
    // Flush microtasks so the second switch's page is delivered through
    // `onInitialPageLoaded` and the active session's pagination state is
    // settled before we resolve the stale first page.
    await new Promise<void>(resolve => setImmediate(resolve));

    // The active session's pagination state reflects the second switch.
    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(true);
    expect(atomValue<number>(config.store, mgr.atoms.olderMessagesOmittedItemCount)).toBe(0);
    expect(
      atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList).map(m => m.info.id)
    ).toEqual(['msg-current']);

    // The first switch's slow page eventually resolves. Its stale
    // cursor, messages, and omitted count must not overwrite the
    // active session's pagination state.
    resolveFirstPage(
      makePage({
        kiloSessionId: 'ses-1',
        nextCursor: 'stale-cursor',
        messages: [makePageMessage('msg-stale', 'ses-1', 'stale')],
        omittedItemCount: 99,
      })
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(atomValue<boolean>(config.store, mgr.atoms.hasOlderMessages)).toBe(true);
    expect(atomValue<number>(config.store, mgr.atoms.olderMessagesOmittedItemCount)).toBe(0);
    expect(
      atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList).map(m => m.info.id)
    ).toEqual(['msg-current']);
  });
});
