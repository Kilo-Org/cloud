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
import { kiloId, cloudAgentId, stubUserMessage, stubTextPart } from './test-helpers';
import type { CloudStatus, ResolvedSession, SessionActivity } from './types';

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
  prompt: null,
  initialMessageId: null,
} satisfies FetchedSessionData;

function createMockConfig(overrides: Partial<SessionManagerConfig> = {}): SessionManagerConfig {
  return {
    store: createStore(),
    resolveSession: jest.fn().mockResolvedValue({
      type: 'cloud-agent',
      kiloSessionId: kiloId('ses-1'),
      cloudAgentSessionId: cloudAgentId('agent-1'),
    }),
    getTicket: jest.fn().mockResolvedValue('ticket-123'),
    fetchSnapshot: jest.fn().mockResolvedValue({ info: {}, messages: [] }),
    getAuthToken: jest.fn().mockResolvedValue('token-123'),
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
    mockSession.storage = latestStorage;
    latestStorage = null;
    mockSessionCallbacks.onQuestionAsked = undefined;
    mockSessionCallbacks.onQuestionResolved = undefined;
    mockSessionCallbacks.onPermissionAsked = undefined;
    mockSessionCallbacks.onPermissionResolved = undefined;
    mockSessionCallbacks.onSessionCreated = undefined;
    mockSessionCallbacks.onResolved = undefined;
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
  });

  // -------------------------------------------------------------------------
  // Initial message pre-insertion (new sessions before initiation)
  // -------------------------------------------------------------------------

  describe('initial message pre-insertion', () => {
    it('pre-inserts user message for non-initiated sessions with prompt and initialMessageId', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123);
      const config = createMockConfig({
        fetchSession: jest.fn().mockResolvedValue({
          ...defaultFetchedSession,
          isInitiated: false,
          prompt: 'Fix the bug',
          initialMessageId: 'msg_000000000000AAAAAAAAAAAAAA',
        }),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const messages = atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.info.id).toBe('msg_000000000000AAAAAAAAAAAAAA');
      expect(messages[0]?.info.role).toBe('user');
      expect(messages[0]?.info.time.created).toBe(1_700_000_000_123);
      const textPart = messages[0]?.parts[0];
      expect(textPart?.type).toBe('text');
      if (textPart?.type === 'text') {
        expect(textPart.text).toBe('Fix the bug');
      }
    });

    it('pre-inserts user message for initiated sessions with prompt and initialMessageId', async () => {
      const config = createMockConfig({
        fetchSession: jest.fn().mockResolvedValue({
          ...defaultFetchedSession,
          isInitiated: true,
          prompt: 'Fix the bug',
          initialMessageId: 'msg_000000000000AAAAAAAAAAAAAA',
        }),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const messages = atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.info.id).toBe('msg_000000000000AAAAAAAAAAAAAA');
    });

    it('does not pre-insert message when initialMessageId is null', async () => {
      const config = createMockConfig({
        fetchSession: jest.fn().mockResolvedValue({
          ...defaultFetchedSession,
          isInitiated: false,
          prompt: 'Fix the bug',
          initialMessageId: null,
        }),
      });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const messages = atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList);
      expect(messages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Overlapping switchSession
  // -------------------------------------------------------------------------

  describe('overlapping switchSession', () => {
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
        prompt: null,
        initialMessageId: null,
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
    it('creates optimistic message and calls session.send', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_456);
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockImplementation(() => new Promise(() => {}));
      void mgr.send({ prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' });

      const messages = atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList);
      expect(messages).toHaveLength(1);
      const [optimisticMessage] = messages;
      expect(optimisticMessage?.info.role).toBe('user');
      expect(optimisticMessage?.info.time.created).toBe(1_700_000_000_456);
      expect(optimisticMessage?.info.id).toMatch(/^msg_/);
      expect(optimisticMessage?.parts[0]?.id).toBe(`${optimisticMessage?.info.id}-text`);
      expect(optimisticMessage?.parts[0]?.messageID).toBe(optimisticMessage?.info.id);
      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        variant: undefined,
        images: undefined,
      });
    });

    it('reconciles optimistic user text when authoritative part has a different id', async () => {
      const prompt =
        "I want to build mobile portrait mode friendly interactive birthday invitation for an upcoming 6 year old girl party. Please suggest some cool ideas and let's implement.";
      const realPartId = 'prt_ca0395df1001ez5Rq0YoFEEjdO';
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      if (!latestStorage) throw new Error('expected session storage');

      mockSession.send.mockImplementation(() => new Promise(() => {}));
      void mgr.send({ prompt, mode: 'code', model: 'claude-3-5-sonnet' });

      const [optimisticMessage] = atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList);
      const messageId = optimisticMessage?.info.id;
      if (!messageId) throw new Error('expected optimistic message id');

      latestStorage.upsertMessage(
        stubUserMessage({
          id: messageId,
          sessionID: 'ses-1',
          time: { created: 1_772_214_640_111 },
          agent: 'code',
          model: { providerID: 'kilo', modelID: 'anthropic/claude-opus-4.6' },
        })
      );
      latestStorage.upsertPart(
        messageId,
        stubTextPart({
          id: realPartId,
          sessionID: 'ses-1',
          messageID: messageId,
          text: prompt,
          time: { start: 1_772_214_640_152 },
        })
      );

      const [message] = atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList);
      expect(message?.parts).toEqual([
        expect.objectContaining({ id: realPartId, type: 'text', text: prompt }),
      ]);
    });

    it('does not persist optimistic message for remote sessions', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));
      mockSessionCallbacks.onResolved?.({ type: 'remote', kiloSessionId: kiloId('ses-1') });

      mockSession.send.mockResolvedValue(undefined);
      await mgr.send({ prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' });

      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
      });
      expect(atomValue<StoredMessage[]>(config.store, mgr.atoms.messagesList)).toHaveLength(0);
    });

    it('clears optimistic message and sets error indicator on failure', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockRejectedValue(new Error('ECONNREFUSED'));
      const accepted = await mgr.send({
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
      });

      expect(accepted).toBe(false);
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

    it('calls onSendFailed with prompt on failure', async () => {
      const onSendFailed = jest.fn();
      const config = createMockConfig({ onSendFailed });
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      const error = new Error('fail');
      mockSession.send.mockRejectedValue(error);
      await mgr.send({ prompt: 'My prompt', mode: 'code', model: 'claude-3-5-sonnet' });

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
        prompt: 'My prompt',
        mode: 'code',
        model: 'claude-3-5-sonnet',
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
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        variant: 'high',
      });

      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        variant: 'high',
        images: undefined,
      });
    });

    it('passes images through to session.send', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);
      const images = { path: 'cloud-agent/message-1', files: ['image.png'] };

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockResolvedValue(undefined);
      const accepted = await mgr.send({
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        images,
      });

      expect(accepted).toBe(true);
      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        variant: undefined,
        images,
      });
    });

    it('omits variant when not provided (backward compat)', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      await mgr.switchSession(kiloId('ses-1'));

      mockSession.send.mockResolvedValue(undefined);
      await mgr.send({ prompt: 'Hello', mode: 'code', model: 'claude-3-5-sonnet' });

      expect(mockSession.send).toHaveBeenCalledWith({
        messageId: expect.stringMatching(/^msg_/),
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
        variant: undefined,
      });
    });

    it('without active session sets error indicator', async () => {
      const config = createMockConfig();
      const mgr = createSessionManager(config);

      // No switchSession — no active session
      const accepted = await mgr.send({
        prompt: 'Hello',
        mode: 'code',
        model: 'claude-3-5-sonnet',
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
        mgr.send({ prompt: 'follow-up message', mode: 'code', model: 'claude-3-5-sonnet' })
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

      expect(config.prepare).toHaveBeenCalledWith(input);
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
