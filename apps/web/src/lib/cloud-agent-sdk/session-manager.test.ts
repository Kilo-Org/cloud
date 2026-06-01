import { createStore } from 'jotai';
import {
  createSessionManager,
  formatError,
  type SessionManagerConfig,
  type FetchedSessionData,
  type StoredMessage,
} from './session-manager';
import { createCloudAgentSession } from './session';
import type { JotaiSessionStorage } from './storage/jotai';
import type { AssistantMessage, UserMessage } from '@/types/opencode.gen';
import { kiloId, cloudAgentId, stubUserMessage, stubTextPart, makeSnapshot } from './test-helpers';
import type { CloudStatus, MessageDeliveryState, ResolvedSession, SessionActivity } from './types';

// ---------------------------------------------------------------------------
// Mock createCloudAgentSession — prevents real WebSocket connections
// ---------------------------------------------------------------------------

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
    getQuestion: jest.fn(() => null),
    getSessionInfo: jest.fn(() => null),
    getPermission: jest.fn(() => null),
    getSuggestion: jest.fn(() => null),
    getPendingMessages: jest.fn<ReadonlyMap<string, MessageDeliveryState>, []>(() => new Map()),
  },
  storage: null as JotaiSessionStorage | null,
};

const mockSessionCallbacks: {
  onSessionCreated?: (info: { id: string; parentID: string | null }) => void;
  onQuestionAsked?: (...args: unknown[]) => void;
  onQuestionResolved?: (...args: unknown[]) => void;
  onPermissionAsked?: (...args: unknown[]) => void;
  onPermissionResolved?: (...args: unknown[]) => void;
  onSuggestionAsked?: (...args: unknown[]) => void;
  onSuggestionResolved?: (...args: unknown[]) => void;
  onResolved?: (resolved: ResolvedSession) => void;
  onMessageQueued?: (messageId: string) => void;
  onMessageCompleted?: (messageId: string) => void;
  onMessageFailed?: (
    messageId: string,
    state: Extract<MessageDeliveryState, { status: 'failed' }>
  ) => void;
} = {};

let latestStorage: JotaiSessionStorage | null = null;

jest.mock('./session', () => ({
  createCloudAgentSession: jest.fn(
    (sessionConfig: {
      kiloSessionId: string;
      storage: JotaiSessionStorage;
      onSessionCreated?: (info: { id: string; parentID: string | null }) => void;
      onQuestionAsked?: (...args: unknown[]) => void;
      onQuestionResolved?: (...args: unknown[]) => void;
      onPermissionAsked?: (...args: unknown[]) => void;
      onPermissionResolved?: (...args: unknown[]) => void;
      onSuggestionAsked?: (...args: unknown[]) => void;
      onSuggestionResolved?: (...args: unknown[]) => void;
      onResolved?: (resolved: ResolvedSession) => void;
      onMessageQueued?: (messageId: string) => void;
      onMessageCompleted?: (messageId: string) => void;
      onMessageFailed?: (
        messageId: string,
        state: Extract<MessageDeliveryState, { status: 'failed' }>
      ) => void;
      transport?: { userWebConnection?: unknown };
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
        sessionConfig.onSessionCreated?.({ id: sessionConfig.kiloSessionId, parentID: null });
      });
      mockSessionCallbacks.onSessionCreated = sessionConfig.onSessionCreated;
      mockSessionCallbacks.onQuestionAsked = sessionConfig.onQuestionAsked;
      mockSessionCallbacks.onQuestionResolved = sessionConfig.onQuestionResolved;
      mockSessionCallbacks.onPermissionAsked = sessionConfig.onPermissionAsked;
      mockSessionCallbacks.onPermissionResolved = sessionConfig.onPermissionResolved;
      mockSessionCallbacks.onSuggestionAsked = sessionConfig.onSuggestionAsked;
      mockSessionCallbacks.onSuggestionResolved = sessionConfig.onSuggestionResolved;
      mockSessionCallbacks.onResolved = sessionConfig.onResolved;
      mockSessionCallbacks.onMessageQueued = sessionConfig.onMessageQueued;
      mockSessionCallbacks.onMessageCompleted = sessionConfig.onMessageCompleted;
      mockSessionCallbacks.onMessageFailed = sessionConfig.onMessageFailed;
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
    mockSessionCallbacks.onQuestionAsked = undefined;
    mockSessionCallbacks.onQuestionResolved = undefined;
    mockSessionCallbacks.onPermissionAsked = undefined;
    mockSessionCallbacks.onPermissionResolved = undefined;
    mockSessionCallbacks.onSessionCreated = undefined;
    mockSessionCallbacks.onResolved = undefined;
    mockSessionCallbacks.onMessageQueued = undefined;
    mockSessionCallbacks.onMessageCompleted = undefined;
    mockSessionCallbacks.onMessageFailed = undefined;
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
        variant?: string | null;
      }>(config.store, mgr.atoms.sessionConfig);
      expect(sessionConfig).toEqual({
        sessionId: 'agent-1',
        repository: 'test/repo',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        variant: null,
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
          model: 'claude-3-5-sonnet',
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
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
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
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
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
          model: 'claude-3-5-sonnet',
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
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
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
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
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
        payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' },
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
        mockSessionCallbacks.onSessionCreated?.({ id: 'ses-root', parentID: null });
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
        mockSessionCallbacks.onSessionCreated?.({ id: 'ses-active', parentID: null });
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
        mockSessionCallbacks.onSessionCreated?.({ id: 'ses-root', parentID: null });
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
      mockSessionCallbacks.onSessionCreated?.({ id: realRootId, parentID: null });

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
  // delivery failure indicator
  // -------------------------------------------------------------------------

  describe('delivery failure status indicator', () => {
    it('exhausted-retry failure sets an error indicator and leaves failedPrompt null', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const onMessageFailed = mockSessionCallbacks.onMessageFailed;
      if (!onMessageFailed) {
        throw new Error('Expected onMessageFailed to be plumbed through');
      }
      onMessageFailed('m1', {
        status: 'failed',
        error: 'flush failed',
        reason: 'exhausted',
        attempts: 5,
      });

      const indicator = atomValue<{ type: string; message: string } | null>(
        config.store,
        mgr.atoms.statusIndicator
      );
      expect(indicator).toEqual(
        expect.objectContaining({ type: 'error', message: 'Message failed to deliver' })
      );
      expect(atomValue<string | null>(config.store, mgr.atoms.failedPrompt)).toBeNull();
    });

    it('interrupted queued failure sets an error indicator with the interrupted wording', async () => {
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
    mockSession.state.getActivity.mockReturnValue({ type: 'idle' as const });
    subscriberCallbackRef.current?.();

    expect(atomValue<boolean>(config.store, mgr.atoms.isReadOnly)).toBe(true);
  });
});
