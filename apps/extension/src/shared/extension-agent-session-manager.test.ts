/* eslint-disable require-await, @typescript-eslint/require-await -- injectable fakes settle without await */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KiloSessionId,
  SessionManager,
  SessionManagerConfig,
} from '@kilocode/cloud-agent-sdk';

// Snapshot the config that gets passed to createSessionManager so every test
// can assert on the individual fields without reaching into the SDK.
let capturedConfig: SessionManagerConfig | null = null;
const mockCreateSessionManager = vi.fn((config: SessionManagerConfig): SessionManager => {
  capturedConfig = config;
  return { atoms: {} as never } as unknown as SessionManager;
});

vi.mock('@kilocode/cloud-agent-sdk', () => ({
  createBrowserLifecycleHooks: vi.fn(() => ({})),
  createSessionManager: mockCreateSessionManager,
}));

const {
  createExtensionAgentSessionManager,
  fetchSessionWithNotFoundRetry,
  readFetchSessionErrorCode,
} = await import('./extension-agent-session-manager');
const { getCloudAgentWsUrl } = await import('./cloud-agent-config');

const SESSION_ID = 'ses_test_session_id_0000000001' as KiloSessionId;
const CLOUD_AGENT_ID = 'agent_12345678-1234-1234-1234-123456789abc';

// ---- tRPC mock helpers ----

function mockQuery(result: unknown) {
  return vi.fn(async () => result);
}
function mockMutate(result: unknown = undefined) {
  return vi.fn(async () => result);
}

function makeTrpcMock() {
  const get = mockQuery({ session_id: SESSION_ID, parent_session_id: null });
  const getSessionMessages = mockQuery({ info: { id: SESSION_ID }, messages: [] });
  const getSessionMessagesPage = mockQuery({
    kiloSessionId: SESSION_ID,
    history: null,
  });
  const getWithRuntimeState = mockQuery({
    session_id: SESSION_ID,
    title: 'test',
    cloud_agent_session_id: CLOUD_AGENT_ID,
    organization_id: null,
    git_url: null,
    git_branch: null,
    created_on_platform: 'web',
    created_at: new Date(),
    updated_at: new Date(),
    version: 1,
    total_cost_microdollars: 0,
    runtimeState: null,
    associatedPr: null,
  });
  const list = mockQuery({ sessions: [] });
  const sendMessage = mockMutate();
  const interruptSession = mockMutate();
  const answerQuestion = mockMutate();
  const rejectQuestion = mockMutate();
  const answerPermission = mockMutate();
  const prepareSession = mockMutate({
    cloudAgentSessionId: CLOUD_AGENT_ID,
    kiloSessionId: SESSION_ID,
  });
  const initiateFromPreparedSession = mockMutate();

  const orgSendMessage = mockMutate();
  const orgInterruptSession = mockMutate();
  const orgAnswerQuestion = mockMutate();
  const orgRejectQuestion = mockMutate();
  const orgAnswerPermission = mockMutate();
  const orgPrepareSession = mockMutate({
    cloudAgentSessionId: CLOUD_AGENT_ID,
    kiloSessionId: SESSION_ID,
  });
  const orgInitiateFromPreparedSession = mockMutate();

  return {
    cliSessionsV2: {
      get: { query: get },
      getSessionMessages: { query: getSessionMessages },
      getSessionMessagesPage: { query: getSessionMessagesPage },
      getWithRuntimeState: { query: getWithRuntimeState },
    },
    activeSessions: { list: { query: list } },
    cloudAgentNext: {
      sendMessage: { mutate: sendMessage },
      interruptSession: { mutate: interruptSession },
      answerQuestion: { mutate: answerQuestion },
      rejectQuestion: { mutate: rejectQuestion },
      answerPermission: { mutate: answerPermission },
      prepareSession: { mutate: prepareSession },
      initiateFromPreparedSession: { mutate: initiateFromPreparedSession },
    },
    organizations: {
      cloudAgentNext: {
        sendMessage: { mutate: orgSendMessage },
        interruptSession: { mutate: orgInterruptSession },
        answerQuestion: { mutate: orgAnswerQuestion },
        rejectQuestion: { mutate: orgRejectQuestion },
        answerPermission: { mutate: orgAnswerPermission },
        prepareSession: { mutate: orgPrepareSession },
        initiateFromPreparedSession: { mutate: orgInitiateFromPreparedSession },
      },
    },
  };
}

function makeDefaultOptions() {
  return {
    store: { get: vi.fn(), set: vi.fn(), sub: vi.fn() } as never,
    trpcClient: makeTrpcMock() as never,
    organizationId: null as string | null,
    getToken: vi.fn(() => 'test-token'),
    apiBaseUrl: 'https://api.test',
    userWebConnection: {} as never,
  };
}

function notFoundError(): Error {
  const error = new Error('Session not found') as Error & { data: { code: string } };
  error.data = { code: 'NOT_FOUND' };
  return error;
}

function withFakeFetch(response: Response) {
  const originalFetch = globalThis.fetch;
  const mock = vi.fn(async () => response);
  globalThis.fetch = mock as never;
  return {
    mock,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// ===========================================================================
// readFetchSessionErrorCode
// ===========================================================================

describe('readFetchSessionErrorCode', () => {
  it('reads data.code', () => {
    expect(readFetchSessionErrorCode({ data: { code: 'NOT_FOUND' } })).toBe('NOT_FOUND');
  });

  it('reads shape.data.code', () => {
    expect(readFetchSessionErrorCode({ shape: { data: { code: 'FORBIDDEN' } } })).toBe('FORBIDDEN');
  });

  it('reads top-level code', () => {
    expect(readFetchSessionErrorCode({ code: 'TIMEOUT' })).toBe('TIMEOUT');
  });

  it('returns undefined for non-objects', () => {
    expect(readFetchSessionErrorCode(null)).toBeUndefined();
    expect(readFetchSessionErrorCode('nope')).toBeUndefined();
  });
});

// ===========================================================================
// fetchSessionWithNotFoundRetry
// ===========================================================================

describe('fetchSessionWithNotFoundRetry', () => {
  type QueryFn = NonNullable<Parameters<typeof fetchSessionWithNotFoundRetry>[1]>['query'];
  const ok = { ok: true } as unknown as Awaited<ReturnType<NonNullable<QueryFn>>>;

  it('returns on the first successful query without sleeping', async () => {
    const queryMock = vi.fn(async () => ok);
    const sleep = vi.fn(async () => undefined);
    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).resolves.toBe(ok);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries NOT_FOUND up to 8 times then succeeds on the 9th', async () => {
    const queryMock = vi
      .fn()
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockResolvedValueOnce(ok);
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).resolves.toBe(ok);

    expect(queryMock).toHaveBeenCalledTimes(9); // 1 initial + 8 retries
    expect(sleep).toHaveBeenCalledTimes(8);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('exhausts 8 retries then throws on the 9th attempt', async () => {
    const queryMock = vi.fn(async () => {
      throw notFoundError();
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });

    // 1 initial + 8 retries = 9 total calls
    expect(queryMock).toHaveBeenCalledTimes(9);
    expect(sleep).toHaveBeenCalledTimes(8);
  });

  it('fails immediately on non-NOT_FOUND error', async () => {
    const error = Object.assign(new Error('boom'), { data: { code: 'INTERNAL_SERVER_ERROR' } });
    const queryMock = vi.fn(async () => {
      throw error;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).rejects.toBe(error);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails immediately when the error has no tRPC code', async () => {
    const error = new Error('network');
    const queryMock = vi.fn(async () => {
      throw error;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).rejects.toBe(error);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// createExtensionAgentSessionManager
// ===========================================================================

describe('createExtensionAgentSessionManager', () => {
  beforeEach(() => {
    capturedConfig = null;
    mockCreateSessionManager.mockClear();
  });

  it('passes lifecycle hooks, store, and userWebConnection into the SDK', () => {
    const opts = makeDefaultOptions();
    createExtensionAgentSessionManager(opts);
    expect(capturedConfig!.store).toBe(opts.store);
    expect(capturedConfig!.userWebConnection).toBe(opts.userWebConnection);
    expect(capturedConfig!.lifecycleHooks).toBeTruthy();
    expect(capturedConfig!.websocketBaseUrl).toBe(getCloudAgentWsUrl());
  });

  // ---- resolveSession ----

  describe('resolveSession', () => {
    it('returns cloud-agent when cloud_agent_session_id is present', async () => {
      const trpc = makeTrpcMock();
      // Make get return a session with cloud_agent_session_id
      trpc.cliSessionsV2.get.query = mockQuery({
        session_id: SESSION_ID,
        cloud_agent_session_id: CLOUD_AGENT_ID,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toEqual({
        type: 'cloud-agent',
        kiloSessionId: SESSION_ID,
        cloudAgentSessionId: CLOUD_AGENT_ID,
      });
    });

    it('returns remote when session is in active sessions with capabilities', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        session_id: SESSION_ID,
        cloud_agent_session_id: null,
      });
      trpc.activeSessions.list.query = mockQuery({
        sessions: [{ id: SESSION_ID, capabilities: { attachments: true } }],
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toEqual({
        type: 'remote',
        kiloSessionId: SESSION_ID,
        capabilities: { attachments: true },
      });
    });

    it('returns remote without capabilities when session is in active sessions but has no capabilities', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        session_id: SESSION_ID,
        cloud_agent_session_id: null,
      });
      trpc.activeSessions.list.query = mockQuery({
        sessions: [{ id: SESSION_ID }],
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toEqual({ type: 'remote', kiloSessionId: SESSION_ID });
    });

    it('returns read-only when session is not in active sessions', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        session_id: SESSION_ID,
        cloud_agent_session_id: null,
      });
      trpc.activeSessions.list.query = mockQuery({ sessions: [] });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toEqual({ type: 'read-only', kiloSessionId: SESSION_ID });
    });

    it('propagates a failed cliSessionsV2.get query', async () => {
      const trpc = makeTrpcMock();
      const error = new Error('DB down');
      trpc.cliSessionsV2.get.query = vi.fn(async () => {
        throw error;
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      await expect(capturedConfig!.resolveSession(SESSION_ID)).rejects.toBe(error);
    });

    it('passes organizationId to activeSessions.list when org is set', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        session_id: SESSION_ID,
        cloud_agent_session_id: null,
      });
      const listQuery = mockQuery({ sessions: [] });
      trpc.activeSessions.list.query = listQuery;
      const opts = {
        ...makeDefaultOptions(),
        trpcClient: trpc as never,
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.resolveSession(SESSION_ID);
      expect(listQuery).toHaveBeenCalledWith({
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      });
    });

    it('passes organizationId: null to activeSessions.list when personal (null)', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        session_id: SESSION_ID,
        cloud_agent_session_id: null,
      });
      const listQuery = mockQuery({ sessions: [] });
      trpc.activeSessions.list.query = listQuery;
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never, organizationId: null };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.resolveSession(SESSION_ID);
      expect(listQuery).toHaveBeenCalledWith({ organizationId: null });
    });
  });

  // ---- getTicket ----

  describe('getTicket', () => {
    it('builds correct ticket URL and returns ticket', async () => {
      const { mock, restore } = withFakeFetch(
        new Response(JSON.stringify({ ticket: 'ticket-123' }), { status: 200 })
      );
      try {
        const opts = makeDefaultOptions();
        opts.getToken = vi.fn(() => 'bearer-token');
        createExtensionAgentSessionManager(opts);
        const ticket = await capturedConfig!.getTicket(CLOUD_AGENT_ID as never);
        expect(ticket).toBe('ticket-123');
        expect(mock).toHaveBeenCalledTimes(1);
        const callUrl = (mock.mock.calls[0] as unknown as [string])[0];
        expect(callUrl).toBe('https://api.test/api/cloud-agent-next/sessions/stream-ticket');
        const init = (mock.mock.calls[0] as unknown as [string, RequestInit])[1];
        expect(init.headers).toMatchObject({
          'Content-Type': 'application/json',
          Authorization: 'Bearer bearer-token',
        });
        const body = JSON.parse(init.body as string);
        expect(body.cloudAgentSessionId).toBe(CLOUD_AGENT_ID);
        expect(body).not.toHaveProperty('organizationId');
      } finally {
        restore();
      }
    });

    it('includes organizationId in body when org is set', async () => {
      const { mock, restore } = withFakeFetch(
        new Response(JSON.stringify({ ticket: 'ticket-org' }), { status: 200 })
      );
      try {
        const opts = {
          ...makeDefaultOptions(),
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        };
        createExtensionAgentSessionManager(opts);
        await capturedConfig!.getTicket(CLOUD_AGENT_ID as never);
        const init = (mock.mock.calls[0] as unknown as [string, RequestInit])[1];
        const body = JSON.parse(init.body as string);
        expect(body.organizationId).toBe('550e8400-e29b-41d4-a716-446655440000');
      } finally {
        restore();
      }
    });

    it('omits Authorization header when getToken returns undefined', async () => {
      const { mock, restore } = withFakeFetch(
        new Response(JSON.stringify({ ticket: 'ticket-noauth' }), { status: 200 })
      );
      try {
        const opts = makeDefaultOptions();
        opts.getToken = vi.fn<() => string | undefined>(
          () => undefined
        ) as unknown as typeof opts.getToken;
        createExtensionAgentSessionManager(opts);
        await capturedConfig!.getTicket(CLOUD_AGENT_ID as never);
        const init = (mock.mock.calls[0] as unknown as [string, RequestInit])[1];
        expect(init.headers).not.toHaveProperty('Authorization');
      } finally {
        restore();
      }
    });

    it('throws on non-ok response', async () => {
      const { restore } = withFakeFetch(
        new Response(JSON.stringify({ error: 'bad' }), { status: 401 })
      );
      try {
        const opts = makeDefaultOptions();
        createExtensionAgentSessionManager(opts);
        await expect(capturedConfig!.getTicket(CLOUD_AGENT_ID as never)).rejects.toThrow('bad');
      } finally {
        restore();
      }
    });

    it('throws when ticket is missing from response', async () => {
      const { restore } = withFakeFetch(new Response(JSON.stringify({}), { status: 200 }));
      try {
        const opts = makeDefaultOptions();
        createExtensionAgentSessionManager(opts);
        await expect(capturedConfig!.getTicket(CLOUD_AGENT_ID as never)).rejects.toThrow(
          'Missing ticket'
        );
      } finally {
        restore();
      }
    });
  });

  // ---- fetchSnapshot ----

  describe('fetchSnapshot', () => {
    it('fetches session data and messages in parallel', async () => {
      const trpc = makeTrpcMock();
      const getQuery = mockQuery({
        session_id: SESSION_ID,
        parent_session_id: 'parent',
        cloud_agent_session_id: null,
      });
      const msgsQuery = mockQuery({
        info: { id: SESSION_ID, parentID: 'parent', model: { providerID: 'kilo', id: 'gpt' } },
        messages: [{ info: { role: 'user', time: {} }, parts: [] }],
      });
      trpc.cliSessionsV2.get.query = getQuery;
      trpc.cliSessionsV2.getSessionMessages.query = msgsQuery;
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const snapshot = await capturedConfig!.fetchSnapshot(SESSION_ID);
      expect(snapshot.info.id).toBe(SESSION_ID);
      expect(snapshot.info.parentID).toBe('parent');
      expect(snapshot.info.model).toEqual({ providerID: 'kilo', id: 'gpt' });
      expect(snapshot.messages).toEqual([{ info: { role: 'user', time: {} }, parts: [] }]);
    });
  });

  // ---- fetchSnapshotPage ----

  describe('fetchSnapshotPage', () => {
    it('returns empty success when history is null', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getSessionMessagesPage.query = mockQuery({
        kiloSessionId: SESSION_ID,
        history: null,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
      expect(result).toEqual({
        kind: 'success',
        info: { id: SESSION_ID },
        messages: [],
        nextCursor: null,
        omittedItemCount: 0,
      });
    });

    it('returns success page when history has messages array', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getSessionMessagesPage.query = mockQuery({
        kiloSessionId: SESSION_ID,
        history: {
          messages: [{ info: { role: 'user', time: {} }, parts: [] }],
          nextCursor: 'cursor-1',
          omittedItemCount: 5,
        },
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.fetchSnapshotPage!(SESSION_ID, { cursor: 'prev' });
      expect(result).toEqual({
        kind: 'success',
        info: { id: SESSION_ID },
        messages: [{ info: { role: 'user', time: {} }, parts: [] }],
        nextCursor: 'cursor-1',
        omittedItemCount: 5,
      });
    });

    it('passes cursor to query', async () => {
      const trpc = makeTrpcMock();
      const pageQuery = mockQuery({ kiloSessionId: SESSION_ID, history: null });
      trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.fetchSnapshotPage!(SESSION_ID, { cursor: 'my-cursor' });
      expect(pageQuery).toHaveBeenCalledWith({ session_id: SESSION_ID, cursor: 'my-cursor' });
    });
  });

  // ---- API (personal) ----

  describe('api (personal — organizationId = null)', () => {
    function setup() {
      const trpc = makeTrpcMock();
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never, organizationId: null };
      createExtensionAgentSessionManager(opts);
      return trpc;
    }

    it('send calls personal cloudAgentNext.sendMessage with autoCommit + messageId', async () => {
      const trpc = setup();
      await capturedConfig!.api.send({
        sessionId: CLOUD_AGENT_ID as never,
        payload: { type: 'prompt', prompt: 'hi', mode: 'code', model: 'gpt' },
        messageId: 'msg-1',
      });
      expect(trpc.cloudAgentNext.sendMessage.mutate).toHaveBeenCalledWith(
        {
          cloudAgentSessionId: CLOUD_AGENT_ID,
          payload: { type: 'prompt', prompt: 'hi', mode: 'code', model: 'gpt' },
          autoCommit: true,
          messageId: 'msg-1',
        },
        { context: { skipBatch: true } }
      );
    });

    it('send passes attachments when provided', async () => {
      const trpc = setup();
      await capturedConfig!.api.send({
        sessionId: CLOUD_AGENT_ID as never,
        payload: { type: 'prompt', prompt: 'hi', mode: 'code', model: 'gpt' },
        attachments: { type: 'file', path: '/f', files: [] } as never,
      });
      const call = (trpc.cloudAgentNext.sendMessage.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as unknown as [Record<string, unknown>];
      expect(call[0]['attachments']).toEqual({ type: 'file', path: '/f', files: [] });
    });

    it('interrupt calls personal cloudAgentNext.interruptSession', async () => {
      const trpc = setup();
      await capturedConfig!.api.interrupt({ sessionId: CLOUD_AGENT_ID as never });
      expect(trpc.cloudAgentNext.interruptSession.mutate).toHaveBeenCalledWith(
        { sessionId: CLOUD_AGENT_ID },
        { context: { skipBatch: true } }
      );
    });

    it('answer calls personal cloudAgentNext.answerQuestion', async () => {
      const trpc = setup();
      await capturedConfig!.api.answer({
        sessionId: CLOUD_AGENT_ID as never,
        requestId: 'q1',
        answers: [['a1']],
      });
      expect(trpc.cloudAgentNext.answerQuestion.mutate).toHaveBeenCalledWith(
        { sessionId: CLOUD_AGENT_ID, questionId: 'q1', answers: [['a1']] },
        { context: { skipBatch: true } }
      );
    });

    it('reject calls personal cloudAgentNext.rejectQuestion', async () => {
      const trpc = setup();
      await capturedConfig!.api.reject({
        sessionId: CLOUD_AGENT_ID as never,
        requestId: 'q1',
      });
      expect(trpc.cloudAgentNext.rejectQuestion.mutate).toHaveBeenCalledWith(
        { sessionId: CLOUD_AGENT_ID, questionId: 'q1' },
        { context: { skipBatch: true } }
      );
    });

    it('respondToPermission calls personal cloudAgentNext.answerPermission', async () => {
      const trpc = setup();
      await capturedConfig!.api.respondToPermission({
        sessionId: CLOUD_AGENT_ID as never,
        requestId: 'p1',
        response: 'once',
      });
      expect(trpc.cloudAgentNext.answerPermission.mutate).toHaveBeenCalledWith(
        { sessionId: CLOUD_AGENT_ID, permissionId: 'p1', response: 'once' },
        { context: { skipBatch: true } }
      );
    });
  });

  // ---- API (org) ----

  describe('api (organization)', () => {
    function setup() {
      const trpc = makeTrpcMock();
      const opts = {
        ...makeDefaultOptions(),
        trpcClient: trpc as never,
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      };
      createExtensionAgentSessionManager(opts);
      return trpc;
    }

    it('send calls org cloudAgentNext.sendMessage including organizationId', async () => {
      const trpc = setup();
      await capturedConfig!.api.send({
        sessionId: CLOUD_AGENT_ID as never,
        payload: { type: 'prompt', prompt: 'hi', mode: 'code', model: 'gpt' },
      });
      expect(trpc.organizations.cloudAgentNext.sendMessage.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudAgentSessionId: CLOUD_AGENT_ID,
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
          autoCommit: true,
        }),
        { context: { skipBatch: true } }
      );
    });

    it('interrupt calls org cloudAgentNext.interruptSession', async () => {
      const trpc = setup();
      await capturedConfig!.api.interrupt({ sessionId: CLOUD_AGENT_ID as never });
      expect(trpc.organizations.cloudAgentNext.interruptSession.mutate).toHaveBeenCalledWith(
        { sessionId: CLOUD_AGENT_ID, organizationId: '550e8400-e29b-41d4-a716-446655440000' },
        { context: { skipBatch: true } }
      );
    });

    it('answer calls org cloudAgentNext.answerQuestion', async () => {
      const trpc = setup();
      await capturedConfig!.api.answer({
        sessionId: CLOUD_AGENT_ID as never,
        requestId: 'q1',
        answers: [['a1']],
      });
      expect(trpc.organizations.cloudAgentNext.answerQuestion.mutate).toHaveBeenCalledWith(
        {
          sessionId: CLOUD_AGENT_ID,
          questionId: 'q1',
          answers: [['a1']],
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        },
        { context: { skipBatch: true } }
      );
    });

    it('reject calls org cloudAgentNext.rejectQuestion', async () => {
      const trpc = setup();
      await capturedConfig!.api.reject({ sessionId: CLOUD_AGENT_ID as never, requestId: 'q1' });
      expect(trpc.organizations.cloudAgentNext.rejectQuestion.mutate).toHaveBeenCalledWith(
        {
          sessionId: CLOUD_AGENT_ID,
          questionId: 'q1',
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        },
        { context: { skipBatch: true } }
      );
    });

    it('respondToPermission calls org cloudAgentNext.answerPermission', async () => {
      const trpc = setup();
      await capturedConfig!.api.respondToPermission({
        sessionId: CLOUD_AGENT_ID as never,
        requestId: 'p1',
        response: 'always',
      });
      expect(trpc.organizations.cloudAgentNext.answerPermission.mutate).toHaveBeenCalledWith(
        {
          sessionId: CLOUD_AGENT_ID,
          permissionId: 'p1',
          response: 'always',
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        },
        { context: { skipBatch: true } }
      );
    });
  });

  // ---- prepare / initiate ----

  describe('prepare', () => {
    it('calls personal prepareSession when organizationId is null', async () => {
      const trpc = makeTrpcMock();
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never, organizationId: null };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.prepare({
        prompt: 'hello',
        mode: 'code',
        model: 'gpt',
      });
      expect(trpc.cloudAgentNext.prepareSession.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'hello', mode: 'code', model: 'gpt' }),
        { context: { skipBatch: true } }
      );
    });

    it('calls org prepareSession when organizationId is set', async () => {
      const trpc = makeTrpcMock();
      const opts = {
        ...makeDefaultOptions(),
        trpcClient: trpc as never,
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.prepare({
        prompt: 'hello',
        mode: 'code',
        model: 'gpt',
      });
      expect(trpc.organizations.cloudAgentNext.prepareSession.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'hello',
          mode: 'code',
          model: 'gpt',
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        }),
        { context: { skipBatch: true } }
      );
    });

    it('throws clear v1 error when initialPayload is provided', async () => {
      const opts = makeDefaultOptions();
      createExtensionAgentSessionManager(opts);
      await expect(
        capturedConfig!.prepare({
          prompt: 'hello',
          mode: 'code',
          model: 'gpt',
          initialPayload: {
            type: 'prompt',
            prompt: 'hi',
            mode: 'code',
            model: 'gpt',
          } as never,
        })
      ).rejects.toThrow('initialPayload is not supported in extension v1 sessions');
    });

    it('returns cloudAgentSessionId and kiloSessionId', async () => {
      const trpc = makeTrpcMock();
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.prepare({ prompt: 'hi', mode: 'code', model: 'gpt' });
      expect(result.cloudAgentSessionId).toBe(CLOUD_AGENT_ID);
      expect(result.kiloSessionId).toBe(SESSION_ID);
    });
  });

  describe('initiate', () => {
    it('calls personal initiateFromPreparedSession when organizationId is null', async () => {
      const trpc = makeTrpcMock();
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never, organizationId: null };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.initiate({ cloudAgentSessionId: CLOUD_AGENT_ID as never });
      expect(trpc.cloudAgentNext.initiateFromPreparedSession.mutate).toHaveBeenCalledWith(
        { cloudAgentSessionId: CLOUD_AGENT_ID },
        { context: { skipBatch: true } }
      );
    });

    it('calls org initiateFromPreparedSession when organizationId is set', async () => {
      const trpc = makeTrpcMock();
      const opts = {
        ...makeDefaultOptions(),
        trpcClient: trpc as never,
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.initiate({ cloudAgentSessionId: CLOUD_AGENT_ID as never });
      expect(
        trpc.organizations.cloudAgentNext.initiateFromPreparedSession.mutate
      ).toHaveBeenCalledWith(
        {
          cloudAgentSessionId: CLOUD_AGENT_ID,
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        },
        { context: { skipBatch: true } }
      );
    });
  });

  // ---- fetchSession ----

  describe('fetchSession', () => {
    it('maps getWithRuntimeState result to FetchedSessionData with runtimeState', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = mockQuery({
        session_id: SESSION_ID,
        title: 'My session',
        cloud_agent_session_id: CLOUD_AGENT_ID,
        organization_id: null,
        git_url: 'https://github.com/user/repo',
        git_branch: 'main',
        created_on_platform: 'web',
        total_cost_microdollars: 1500,
        associatedPr: null,
        runtimeState: {
          upstreamBranch: 'feature/x',
          mode: 'code',
          model: 'gpt-4',
          variant: 'thinking',
          githubRepo: 'user/repo',
          initiatedAt: '2026-01-01',
          preparedAt: '2026-01-01',
          prompt: 'do stuff',
          initialMessageId: 'init-msg',
          runtimeAgents: [{ slug: 'ask', name: 'Ask' }],
        },
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data).toMatchObject({
        kiloSessionId: SESSION_ID,
        cloudAgentSessionId: CLOUD_AGENT_ID,
        title: 'My session',
        organizationId: null,
        gitUrl: 'https://github.com/user/repo',
        gitBranch: 'feature/x',
        mode: 'code',
        model: 'gpt-4',
        variant: 'thinking',
        repository: 'user/repo',
        isInitiated: true,
        needsLegacyPrepare: false,
        isPreparingAsync: false,
        prompt: 'do stuff',
        initialMessageId: 'init-msg',
        totalCostMicrodollars: 1500,
        createdOnPlatform: 'web',
      });
      expect(data.runtimeAgents).toEqual([{ slug: 'ask', name: 'Ask' }]);
    });

    it('maps needsLegacyPrepare when cloud_agent_session_id exists but no runtimeState', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = mockQuery({
        session_id: SESSION_ID,
        cloud_agent_session_id: CLOUD_AGENT_ID,
        runtimeState: null,
        title: null,
        organization_id: null,
        git_url: null,
        git_branch: null,
        created_on_platform: 'cli',
        total_cost_microdollars: null,
        associatedPr: null,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.needsLegacyPrepare).toBe(true);
    });

    it('uses git_branch when runtimeState has no upstreamBranch', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = mockQuery({
        session_id: SESSION_ID,
        git_branch: 'fallback-branch',
        cloud_agent_session_id: null,
        runtimeState: { mode: 'code', model: 'gpt' },
        title: null,
        organization_id: null,
        git_url: null,
        created_on_platform: 'cli',
        total_cost_microdollars: null,
        associatedPr: null,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.gitBranch).toBe('fallback-branch');
    });

    it('retries on NOT_FOUND and succeeds on a later attempt', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = vi
        .fn()
        .mockRejectedValueOnce(notFoundError())
        .mockRejectedValueOnce(notFoundError())
        .mockResolvedValue({
          session_id: SESSION_ID,
          title: 'found',
          cloud_agent_session_id: null,
          organization_id: null,
          git_url: null,
          git_branch: null,
          created_on_platform: 'cli',
          total_cost_microdollars: null,
          associatedPr: null,
          runtimeState: null,
        });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.title).toBe('found');
    });
  });
});
