/* eslint-disable require-await, @typescript-eslint/require-await, typescript-eslint/no-unsafe-type-assertion, max-lines, jest/no-hooks, jest/max-expects, vitest/prefer-called-once -- injectable fakes settle without await; mock objects use `as never` for tRPC types; tests exceed line limit to keep related assertions together; beforeEach is standard test setup; max-expects flagged on tests that verify full mock call shape; prefer-called-once conflicts with prefer-called-times */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KiloSessionId,
  SessionManager,
  SessionManagerConfig,
} from '@kilocode/cloud-agent-sdk';

// Snapshot the config that gets passed to createSessionManager so every test
// Can assert on the individual fields without reaching into the SDK.
let capturedConfig: SessionManagerConfig | null = null;
const mockCreateSessionManager = vi.fn((config: SessionManagerConfig): SessionManager => {
  capturedConfig = config;
  return { atoms: {} as never } as unknown as SessionManager;
});

// eslint-disable-next-line typescript-eslint/consistent-type-imports -- vi.mock type parameter requires dynamic import() type
vi.mock<typeof import('@kilocode/cloud-agent-sdk')>(import('@kilocode/cloud-agent-sdk'), () => ({
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
function mockMutate(result?: unknown) {
  return vi.fn(async () => result);
}

function makeTrpcMock() {
  const get = mockQuery({ parent_session_id: null, session_id: SESSION_ID });
  const getSessionMessages = mockQuery({ info: { id: SESSION_ID }, messages: [] });
  const getSessionMessagesPage = mockQuery({
    history: null,
    kiloSessionId: SESSION_ID,
  });
  const getWithRuntimeState = mockQuery({
    associatedPr: null,
    cloud_agent_session_id: CLOUD_AGENT_ID,
    created_at: new Date(),
    created_on_platform: 'web',
    git_branch: null,
    git_url: null,
    organization_id: null,
    runtimeState: null,
    session_id: SESSION_ID,
    title: 'test',
    total_cost_microdollars: 0,
    updated_at: new Date(),
    version: 1,
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
    activeSessions: { list: { query: list } },
    cliSessionsV2: {
      get: { query: get },
      getSessionMessages: { query: getSessionMessages },
      getSessionMessagesPage: { query: getSessionMessagesPage },
      getWithRuntimeState: { query: getWithRuntimeState },
    },
    cloudAgentNext: {
      answerPermission: { mutate: answerPermission },
      answerQuestion: { mutate: answerQuestion },
      initiateFromPreparedSession: { mutate: initiateFromPreparedSession },
      interruptSession: { mutate: interruptSession },
      prepareSession: { mutate: prepareSession },
      rejectQuestion: { mutate: rejectQuestion },
      sendMessage: { mutate: sendMessage },
    },
    organizations: {
      cloudAgentNext: {
        answerPermission: { mutate: orgAnswerPermission },
        answerQuestion: { mutate: orgAnswerQuestion },
        initiateFromPreparedSession: { mutate: orgInitiateFromPreparedSession },
        interruptSession: { mutate: orgInterruptSession },
        prepareSession: { mutate: orgPrepareSession },
        rejectQuestion: { mutate: orgRejectQuestion },
        sendMessage: { mutate: orgSendMessage },
      },
    },
  };
}

function makeDefaultOptions() {
  return {
    apiBaseUrl: 'https://api.test',
    getToken: vi.fn(() => 'test-token'),
    organizationId: null as string | null,
    store: { get: vi.fn(), set: vi.fn(), sub: vi.fn() } as never,
    trpcClient: makeTrpcMock() as never,
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
// ReadFetchSessionErrorCode
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
// FetchSessionWithNotFoundRetry
// ===========================================================================

describe('fetchSessionWithNotFoundRetry', () => {
  type QueryFn = NonNullable<Parameters<typeof fetchSessionWithNotFoundRetry>[1]>['query'];
  const ok = { ok: true } as unknown as Awaited<ReturnType<NonNullable<QueryFn>>>;

  it('returns on the first successful query without sleeping', async () => {
    const queryMock = vi.fn(async () => ok);
    const sleep = vi.fn(async () => {});
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
    const sleep = vi.fn(async () => {});

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).resolves.toBe(ok);

    // 1 initial + 8 retries
    expect(queryMock).toHaveBeenCalledTimes(9);
    expect(sleep).toHaveBeenCalledTimes(8);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('exhausts 8 retries then throws on the 9th attempt', async () => {
    const queryMock = vi.fn(async () => {
      throw notFoundError();
    });
    const sleep = vi.fn(async () => {});

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
    const sleep = vi.fn(async () => {});

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
    const sleep = vi.fn(async () => {});

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
// CreateExtensionAgentSessionManager
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
        cloud_agent_session_id: CLOUD_AGENT_ID,
        session_id: SESSION_ID,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toStrictEqual({
        cloudAgentSessionId: CLOUD_AGENT_ID,
        kiloSessionId: SESSION_ID,
        type: 'cloud-agent',
      });
    });

    it('returns remote when session is in active sessions with capabilities', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        cloud_agent_session_id: null,
        session_id: SESSION_ID,
      });
      trpc.activeSessions.list.query = mockQuery({
        sessions: [{ capabilities: { attachments: true }, id: SESSION_ID }],
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toStrictEqual({
        capabilities: { attachments: true },
        kiloSessionId: SESSION_ID,
        type: 'remote',
      });
    });

    it('returns remote without capabilities when session is in active sessions but has no capabilities', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        cloud_agent_session_id: null,
        session_id: SESSION_ID,
      });
      trpc.activeSessions.list.query = mockQuery({
        sessions: [{ id: SESSION_ID }],
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toStrictEqual({ kiloSessionId: SESSION_ID, type: 'remote' });
    });

    it('returns read-only when session is not in active sessions', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        cloud_agent_session_id: null,
        session_id: SESSION_ID,
      });
      trpc.activeSessions.list.query = mockQuery({ sessions: [] });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toStrictEqual({ kiloSessionId: SESSION_ID, type: 'read-only' });
    });

    it('does not treat empty cloud_agent_session_id as cloud-agent', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        cloud_agent_session_id: '',
        session_id: SESSION_ID,
      });
      trpc.activeSessions.list.query = mockQuery({ sessions: [] });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.resolveSession(SESSION_ID);
      expect(result).toStrictEqual({ kiloSessionId: SESSION_ID, type: 'read-only' });
    });

    it('propagates a failed cliSessionsV2.get query', async () => {
      const trpc = makeTrpcMock();
      const error = new Error('DB down');
      vi.spyOn(trpc.cliSessionsV2.get, 'query').mockImplementation(async () => {
        throw error;
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      await expect(capturedConfig!.resolveSession(SESSION_ID)).rejects.toBe(error);
    });

    it('passes organizationId to activeSessions.list when org is set', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.get.query = mockQuery({
        cloud_agent_session_id: null,
        session_id: SESSION_ID,
      });
      const listQuery = mockQuery({ sessions: [] });
      trpc.activeSessions.list.query = listQuery;
      const opts = {
        ...makeDefaultOptions(),
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
        trpcClient: trpc as never,
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
        cloud_agent_session_id: null,
        session_id: SESSION_ID,
      });
      const listQuery = mockQuery({ sessions: [] });
      trpc.activeSessions.list.query = listQuery;
      const opts = { ...makeDefaultOptions(), organizationId: null, trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.resolveSession(SESSION_ID);
      expect(listQuery).toHaveBeenCalledWith({ organizationId: null });
    });
  });

  // ---- getTicket ----

  describe('getTicket', () => {
    it('builds correct ticket URL and returns ticket', async () => {
      const { mock, restore } = withFakeFetch(
        Response.json({ ticket: 'ticket-123' }, { status: 200 })
      );
      try {
        const opts = makeDefaultOptions();
        vi.spyOn(opts, 'getToken').mockReturnValue('bearer-token');
        createExtensionAgentSessionManager(opts);
        const ticket = await capturedConfig!.getTicket(CLOUD_AGENT_ID as never);
        expect(ticket).toBe('ticket-123');
        expect(mock).toHaveBeenCalledTimes(1);
        const [callUrl] = mock.mock.calls[0] as unknown as [string];
        expect(callUrl).toBe('https://api.test/api/cloud-agent-next/sessions/stream-ticket');
        const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.headers).toMatchObject({
          Authorization: 'Bearer bearer-token',
          'Content-Type': 'application/json',
        });
        const body = JSON.parse(init.body as string) as {
          cloudAgentSessionId: string;
          organizationId?: string;
        };
        expect(body.cloudAgentSessionId).toBe(CLOUD_AGENT_ID);
        expect(body).not.toHaveProperty('organizationId');
      } finally {
        restore();
      }
    });

    it('includes organizationId in body when org is set', async () => {
      const { mock, restore } = withFakeFetch(
        Response.json({ ticket: 'ticket-org' }, { status: 200 })
      );
      try {
        const opts = {
          ...makeDefaultOptions(),
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        };
        createExtensionAgentSessionManager(opts);
        await capturedConfig!.getTicket(CLOUD_AGENT_ID as never);
        const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
        const body = JSON.parse(init.body as string) as {
          cloudAgentSessionId: string;
          organizationId?: string;
        };
        expect(body.organizationId).toBe('550e8400-e29b-41d4-a716-446655440000');
      } finally {
        restore();
      }
    });

    it('omits Authorization header when getToken returns undefined', async () => {
      const { mock, restore } = withFakeFetch(
        Response.json({ ticket: 'ticket-noauth' }, { status: 200 })
      );
      try {
        const opts = makeDefaultOptions();
        opts.getToken = vi.fn<() => string | undefined>(
          // eslint-disable-next-line unicorn/no-useless-undefined -- testing getToken undefined (no-token) path
          () => undefined
        ) as unknown as typeof opts.getToken;
        createExtensionAgentSessionManager(opts);
        await capturedConfig!.getTicket(CLOUD_AGENT_ID as never);
        const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.headers).not.toHaveProperty('Authorization');
      } finally {
        restore();
      }
    });

    it('omits Authorization header when getToken returns empty string', async () => {
      const { mock, restore } = withFakeFetch(
        Response.json({ ticket: 'ticket-empty' }, { status: 200 })
      );
      try {
        const opts = makeDefaultOptions();
        opts.getToken = vi.fn<() => string | undefined>(
          () => ''
        ) as unknown as typeof opts.getToken;
        createExtensionAgentSessionManager(opts);
        await capturedConfig!.getTicket(CLOUD_AGENT_ID as never);
        const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.headers).not.toHaveProperty('Authorization');
      } finally {
        restore();
      }
    });

    it('throws on non-ok response', async () => {
      const { restore } = withFakeFetch(Response.json({ error: 'bad' }, { status: 401 }));
      try {
        const opts = makeDefaultOptions();
        createExtensionAgentSessionManager(opts);
        await expect(capturedConfig!.getTicket(CLOUD_AGENT_ID as never)).rejects.toThrow('bad');
      } finally {
        restore();
      }
    });

    it('throws when ticket is missing from response', async () => {
      const { restore } = withFakeFetch(Response.json({}, { status: 200 }));
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
        cloud_agent_session_id: null,
        parent_session_id: 'parent',
        session_id: SESSION_ID,
      });
      const msgsQuery = mockQuery({
        info: { id: SESSION_ID, model: { id: 'gpt', providerID: 'kilo' }, parentID: 'parent' },
        messages: [{ info: { role: 'user', time: {} }, parts: [] }],
      });
      trpc.cliSessionsV2.get.query = getQuery;
      trpc.cliSessionsV2.getSessionMessages.query = msgsQuery;
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const snapshot = await capturedConfig!.fetchSnapshot(SESSION_ID);
      expect(snapshot.info.id).toBe(SESSION_ID);
      expect(snapshot.info.parentID).toBe('parent');
      expect(snapshot.info.model).toStrictEqual({ id: 'gpt', providerID: 'kilo' });
      expect(snapshot.messages).toStrictEqual([{ info: { role: 'user', time: {} }, parts: [] }]);
    });
  });

  // ---- fetchSnapshotPage ----

  describe('fetchSnapshotPage', () => {
    it('returns empty success when history is null', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        const pageQuery = mockQuery({ history: null, kiloSessionId: SESSION_ID });
        trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
        const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
        createExtensionAgentSessionManager(opts);
        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        // Let the bounded liveness grace probe expire without a page retry.
        await vi.advanceTimersByTimeAsync(10_000);
        const result = await resultPromise;
        expect(result).toStrictEqual({
          info: { id: SESSION_ID },
          kind: 'success',
          messages: [],
          nextCursor: null,
          omittedItemCount: 0,
        });
        // An inactive session must not trigger the delayed-page retry.
        expect(pageQuery).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('forwards the event-log watermark on an empty page so a reopened running session replays persisted events', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        /*
         * Round-8 regression state: the reopened CLI session's initial page
         * read is still empty (session-ingest batches until the turn ends),
         * but the ingest DO already carries the nonce-bearing user message —
         * the tRPC result reports that high-water mark as `watermarkEventId`.
         * The transport seeds its first WebSocket connect from this page
         * watermark (`fromId=0`), so every persisted event replays and the
         * user message reaches the renderer even though the page is empty.
         * Dropping the watermark would connect with `replay=false` and lose
         * the already-persisted message.
         */
        trpc.cliSessionsV2.getSessionMessagesPage.query = mockQuery({
          history: null,
          kiloSessionId: SESSION_ID,
          watermarkEventId: 42,
        });
        const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
        createExtensionAgentSessionManager(opts);
        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        await vi.advanceTimersByTimeAsync(10_000);
        const result = await resultPromise;
        expect(result).toStrictEqual({
          info: { id: SESSION_ID },
          kind: 'success',
          messages: [],
          nextCursor: null,
          omittedItemCount: 0,
          watermarkEventId: 42,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('forwards the event-log watermark on a message page', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getSessionMessagesPage.query = mockQuery({
        history: {
          messages: [
            {
              info: { role: 'user', sessionID: SESSION_ID, time: {} },
              parts: [],
            },
          ],
          nextCursor: null,
          omittedItemCount: 0,
        },
        kiloSessionId: SESSION_ID,
        watermarkEventId: 7,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
      expect(result).toStrictEqual({
        info: { id: SESSION_ID },
        kind: 'success',
        messages: [{ info: { role: 'user', sessionID: SESSION_ID, time: {} }, parts: [] }],
        nextCursor: null,
        omittedItemCount: 0,
        watermarkEventId: 7,
      });
    });

    it('returns success page when history has messages array', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getSessionMessagesPage.query = mockQuery({
        history: {
          messages: [
            {
              info: { role: 'user', sessionID: SESSION_ID, time: {} },
              parts: [
                {
                  id: 'part-1',
                  messageID: 'msg-1',
                  sessionID: SESSION_ID,
                  text: 'hello',
                  type: 'text',
                },
              ],
            },
          ],
          nextCursor: 'cursor-1',
          omittedItemCount: 5,
        },
        kiloSessionId: SESSION_ID,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.fetchSnapshotPage!(SESSION_ID, { cursor: 'prev' });
      expect(result).toStrictEqual({
        info: { id: SESSION_ID },
        kind: 'success',
        messages: [
          {
            info: { role: 'user', sessionID: SESSION_ID, time: {} },
            parts: [
              {
                id: 'part-1',
                messageID: 'msg-1',
                sessionID: SESSION_ID,
                text: 'hello',
                type: 'text',
              },
            ],
          },
        ],
        nextCursor: 'cursor-1',
        omittedItemCount: 5,
      });
    });

    it('normalizes a mismatched server session id to the requested id', async () => {
      const trpc = makeTrpcMock();
      const serverSessionId = 'ses_server_mismatched_0000000001' as KiloSessionId;
      trpc.cliSessionsV2.getSessionMessagesPage.query = mockQuery({
        history: {
          messages: [
            {
              info: { role: 'user', sessionID: serverSessionId, time: {} },
              parts: [
                {
                  id: 'part-1',
                  messageID: 'msg-1',
                  sessionID: serverSessionId,
                  text: 'hello',
                  type: 'text',
                },
              ],
            },
          ],
          nextCursor: 'cursor-1',
          omittedItemCount: 2,
        },
        kiloSessionId: serverSessionId,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
      expect(result).toStrictEqual({
        info: { id: SESSION_ID },
        kind: 'success',
        messages: [
          {
            info: { role: 'user', sessionID: SESSION_ID, time: {} },
            parts: [
              {
                id: 'part-1',
                messageID: 'msg-1',
                sessionID: SESSION_ID,
                text: 'hello',
                type: 'text',
              },
            ],
          },
        ],
        nextCursor: 'cursor-1',
        omittedItemCount: 2,
      });
    });

    it('passes cursor to query without retrying', async () => {
      const trpc = makeTrpcMock();
      const pageQuery = mockQuery({ history: null, kiloSessionId: SESSION_ID });
      trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.fetchSnapshotPage!(SESSION_ID, { cursor: 'my-cursor' });
      expect(pageQuery).toHaveBeenCalledWith({ cursor: 'my-cursor', session_id: SESSION_ID });
      // Cursor pages must not be retried or checked against active sessions.
      expect(pageQuery).toHaveBeenCalledTimes(1);
      expect(trpc.activeSessions.list.query).not.toHaveBeenCalled();
    });

    it('retries an empty page while the session is running', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        const listQuery = mockQuery({ sessions: [{ id: SESSION_ID, status: 'busy' }] });
        trpc.activeSessions.list.query = listQuery;
        const pageQuery = vi
          .fn()
          .mockResolvedValueOnce({ history: null, kiloSessionId: SESSION_ID })
          .mockResolvedValueOnce({
            history: {
              messages: [
                {
                  info: { role: 'user', sessionID: SESSION_ID, time: {} },
                  parts: [],
                },
              ],
              nextCursor: null,
              omittedItemCount: 0,
            },
            kiloSessionId: SESSION_ID,
          });
        trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
        const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
        createExtensionAgentSessionManager(opts);

        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        await vi.advanceTimersByTimeAsync(1000);

        const result = await resultPromise;
        expect(result).toMatchObject({
          kind: 'success',
          messages: [
            {
              info: { sessionID: SESSION_ID },
            },
          ],
        });
        expect(pageQuery).toHaveBeenCalledTimes(2);
        // The retry's active lookup must include cloud-agent sessions.
        expect(listQuery).toHaveBeenCalledWith({
          includeCloudAgentSessions: true,
          organizationId: null,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps retrying a running session until a late-persisted page arrives', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        trpc.activeSessions.list.query = mockQuery({
          sessions: [{ id: SESSION_ID, status: 'busy' }],
        });
        const pageQuery = vi.fn();
        /*
         * The persisted page can lag the whole running turn: only the
         * eleventh read carries messages while the first ten stay empty.
         */
        for (let index = 0; index < 10; index += 1) {
          pageQuery.mockResolvedValueOnce({ history: null, kiloSessionId: SESSION_ID });
        }
        pageQuery.mockResolvedValueOnce({
          history: {
            messages: [
              {
                info: { role: 'user', sessionID: SESSION_ID, time: {} },
                parts: [],
              },
            ],
            nextCursor: null,
            omittedItemCount: 0,
          },
          kiloSessionId: SESSION_ID,
        });
        trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
        const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
        createExtensionAgentSessionManager(opts);

        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        await vi.advanceTimersByTimeAsync(10_000);

        const result = await resultPromise;
        expect(result).toMatchObject({
          kind: 'success',
          messages: [{ info: { sessionID: SESSION_ID } }],
        });
        expect(pageQuery).toHaveBeenCalledTimes(11);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps retrying an empty message page (not just null history) while the session is running', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        trpc.activeSessions.list.query = mockQuery({
          sessions: [{ id: SESSION_ID, status: 'busy' }],
        });
        const pageQuery = vi
          .fn()
          .mockResolvedValueOnce({
            history: { messages: [], nextCursor: null, omittedItemCount: 0 },
            kiloSessionId: SESSION_ID,
          })
          .mockResolvedValueOnce({
            history: {
              messages: [
                {
                  info: { role: 'user', sessionID: SESSION_ID, time: {} },
                  parts: [],
                },
              ],
              nextCursor: null,
              omittedItemCount: 0,
            },
            kiloSessionId: SESSION_ID,
          });
        trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
        const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
        createExtensionAgentSessionManager(opts);

        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        await vi.advanceTimersByTimeAsync(1000);

        const result = await resultPromise;
        expect(result).toMatchObject({
          kind: 'success',
          messages: [{ info: { sessionID: SESSION_ID } }],
        });
        expect(pageQuery).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps checking liveness when the first lookup misses the active row', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        /*
         * The active row is missing on the gate's first read (registration
         * or refresh race), then appears as busy on the liveness grace read.
         */
        const listQuery = vi
          .fn()
          .mockResolvedValueOnce({ sessions: [] })
          .mockResolvedValueOnce({ sessions: [{ id: SESSION_ID, status: 'busy' }] });
        trpc.activeSessions.list.query = listQuery;
        /*
         * The initial page is empty and stays empty through the first retry
         * read, then the persisted messages arrive on the third read.
         */
        const pageQuery = vi
          .fn()
          .mockResolvedValueOnce({ history: null, kiloSessionId: SESSION_ID })
          .mockResolvedValueOnce({ history: null, kiloSessionId: SESSION_ID })
          .mockResolvedValueOnce({
            history: {
              messages: [
                {
                  info: { role: 'user', sessionID: SESSION_ID, time: {} },
                  parts: [],
                },
              ],
              nextCursor: null,
              omittedItemCount: 0,
            },
            kiloSessionId: SESSION_ID,
          });
        trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
        const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
        createExtensionAgentSessionManager(opts);

        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        // Liveness grace sleep + the first retry sleep + the second retry sleep.
        await vi.advanceTimersByTimeAsync(3000);

        const result = await resultPromise;
        expect(result).toMatchObject({
          kind: 'success',
          messages: [{ info: { sessionID: SESSION_ID } }],
        });
        expect(pageQuery).toHaveBeenCalledTimes(3);
        expect(listQuery).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry a listed but idle session (a fresh session start is not delayed)', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        trpc.activeSessions.list.query = mockQuery({
          sessions: [{ id: SESSION_ID, status: 'idle' }],
        });
        const pageQuery = mockQuery({ history: null, kiloSessionId: SESSION_ID });
        trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
        const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
        createExtensionAgentSessionManager(opts);

        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        // Advance the timers so the removed idle-gate loop can settle.
        // The assertion below then distinguishes the two.
        await vi.advanceTimersByTimeAsync(10_000);
        const result = await resultPromise;

        expect(result).toStrictEqual({
          info: { id: SESSION_ID },
          kind: 'success',
          messages: [],
          nextCursor: null,
          omittedItemCount: 0,
        });
        /*
         * No delayed-history retry runs for an idle session. The page
         * resolves on the first read, so the session's own first send is
         * never blocked.
         */
        expect(pageQuery).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops retrying a short time after the session stops running', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        const listQuery = vi
          .fn()
          .mockResolvedValueOnce({ sessions: [{ id: SESSION_ID, status: 'busy' }] })
          .mockResolvedValueOnce({ sessions: [{ id: SESSION_ID, status: 'idle' }] });
        trpc.activeSessions.list.query = listQuery;
        const pageQuery = mockQuery({ history: null, kiloSessionId: SESSION_ID });
        trpc.cliSessionsV2.getSessionMessagesPage.query = pageQuery;
        const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
        createExtensionAgentSessionManager(opts);

        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        await vi.advanceTimersByTimeAsync(10_000);

        const result = await resultPromise;
        expect(result).toMatchObject({ kind: 'success', messages: [] });
        /*
         * The retry stops once the session is no longer running. The expected
         * page count is the initial read, five retry reads, and five grace
         * reads; the idle re-check is an active-sessions call.
         */
        expect(pageQuery).toHaveBeenCalledTimes(11);
        expect(listQuery).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes organizationId and includeCloudAgentSessions in the retry active lookup when org is set', async () => {
      vi.useFakeTimers();
      try {
        const trpc = makeTrpcMock();
        const listQuery = mockQuery({ sessions: [] });
        trpc.activeSessions.list.query = listQuery;
        trpc.cliSessionsV2.getSessionMessagesPage.query = mockQuery({
          history: null,
          kiloSessionId: SESSION_ID,
        });
        const opts = {
          ...makeDefaultOptions(),
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
          trpcClient: trpc as never,
        };
        createExtensionAgentSessionManager(opts);
        const resultPromise = capturedConfig!.fetchSnapshotPage!(SESSION_ID, {});
        await vi.advanceTimersByTimeAsync(10_000);
        await resultPromise;
        expect(listQuery).toHaveBeenCalledWith({
          includeCloudAgentSessions: true,
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---- API (personal) ----

  describe('api (personal — organizationId = null)', () => {
    function setup() {
      const trpc = makeTrpcMock();
      const opts = { ...makeDefaultOptions(), organizationId: null, trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      return trpc;
    }

    it('send calls personal cloudAgentNext.sendMessage with autoCommit + messageId', async () => {
      const trpc = setup();
      await capturedConfig!.api.send({
        messageId: 'msg-1',
        payload: { mode: 'code', model: 'gpt', prompt: 'hi', type: 'prompt' },
        sessionId: CLOUD_AGENT_ID as never,
      });
      expect(trpc.cloudAgentNext.sendMessage.mutate).toHaveBeenCalledWith(
        {
          autoCommit: true,
          cloudAgentSessionId: CLOUD_AGENT_ID,
          messageId: 'msg-1',
          payload: { mode: 'code', model: 'gpt', prompt: 'hi', type: 'prompt' },
        },
        { context: { skipBatch: true } }
      );
    });

    it('send passes attachments when provided', async () => {
      const trpc = setup();
      await capturedConfig!.api.send({
        attachments: { files: [], path: '/f', type: 'file' } as never,
        payload: { mode: 'code', model: 'gpt', prompt: 'hi', type: 'prompt' },
        sessionId: CLOUD_AGENT_ID as never,
      });
      const call = (trpc.cloudAgentNext.sendMessage.mutate as ReturnType<typeof vi.fn>).mock
        .calls[0] as unknown as [Record<string, unknown>];
      expect(call[0]['attachments']).toStrictEqual({ files: [], path: '/f', type: 'file' });
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
        answers: [['a1']],
        requestId: 'q1',
        sessionId: CLOUD_AGENT_ID as never,
      });
      expect(trpc.cloudAgentNext.answerQuestion.mutate).toHaveBeenCalledWith(
        { answers: [['a1']], questionId: 'q1', sessionId: CLOUD_AGENT_ID },
        { context: { skipBatch: true } }
      );
    });

    it('reject calls personal cloudAgentNext.rejectQuestion', async () => {
      const trpc = setup();
      await capturedConfig!.api.reject({
        requestId: 'q1',
        sessionId: CLOUD_AGENT_ID as never,
      });
      expect(trpc.cloudAgentNext.rejectQuestion.mutate).toHaveBeenCalledWith(
        { questionId: 'q1', sessionId: CLOUD_AGENT_ID },
        { context: { skipBatch: true } }
      );
    });

    it('respondToPermission calls personal cloudAgentNext.answerPermission', async () => {
      const trpc = setup();
      await capturedConfig!.api.respondToPermission({
        requestId: 'p1',
        response: 'once',
        sessionId: CLOUD_AGENT_ID as never,
      });
      expect(trpc.cloudAgentNext.answerPermission.mutate).toHaveBeenCalledWith(
        { permissionId: 'p1', response: 'once', sessionId: CLOUD_AGENT_ID },
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
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
        trpcClient: trpc as never,
      };
      createExtensionAgentSessionManager(opts);
      return trpc;
    }

    it('send calls org cloudAgentNext.sendMessage including organizationId', async () => {
      const trpc = setup();
      await capturedConfig!.api.send({
        payload: { mode: 'code', model: 'gpt', prompt: 'hi', type: 'prompt' },
        sessionId: CLOUD_AGENT_ID as never,
      });
      expect(trpc.organizations.cloudAgentNext.sendMessage.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          autoCommit: true,
          cloudAgentSessionId: CLOUD_AGENT_ID,
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        }),
        { context: { skipBatch: true } }
      );
    });

    it('interrupt calls org cloudAgentNext.interruptSession', async () => {
      const trpc = setup();
      await capturedConfig!.api.interrupt({ sessionId: CLOUD_AGENT_ID as never });
      expect(trpc.organizations.cloudAgentNext.interruptSession.mutate).toHaveBeenCalledWith(
        { organizationId: '550e8400-e29b-41d4-a716-446655440000', sessionId: CLOUD_AGENT_ID },
        { context: { skipBatch: true } }
      );
    });

    it('answer calls org cloudAgentNext.answerQuestion', async () => {
      const trpc = setup();
      await capturedConfig!.api.answer({
        answers: [['a1']],
        requestId: 'q1',
        sessionId: CLOUD_AGENT_ID as never,
      });
      expect(trpc.organizations.cloudAgentNext.answerQuestion.mutate).toHaveBeenCalledWith(
        {
          answers: [['a1']],
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
          questionId: 'q1',
          sessionId: CLOUD_AGENT_ID,
        },
        { context: { skipBatch: true } }
      );
    });

    it('reject calls org cloudAgentNext.rejectQuestion', async () => {
      const trpc = setup();
      await capturedConfig!.api.reject({ requestId: 'q1', sessionId: CLOUD_AGENT_ID as never });
      expect(trpc.organizations.cloudAgentNext.rejectQuestion.mutate).toHaveBeenCalledWith(
        {
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
          questionId: 'q1',
          sessionId: CLOUD_AGENT_ID,
        },
        { context: { skipBatch: true } }
      );
    });

    it('respondToPermission calls org cloudAgentNext.answerPermission', async () => {
      const trpc = setup();
      await capturedConfig!.api.respondToPermission({
        requestId: 'p1',
        response: 'always',
        sessionId: CLOUD_AGENT_ID as never,
      });
      expect(trpc.organizations.cloudAgentNext.answerPermission.mutate).toHaveBeenCalledWith(
        {
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
          permissionId: 'p1',
          response: 'always',
          sessionId: CLOUD_AGENT_ID,
        },
        { context: { skipBatch: true } }
      );
    });
  });

  // ---- prepare / initiate ----

  describe('prepare', () => {
    it('calls personal prepareSession when organizationId is null', async () => {
      const trpc = makeTrpcMock();
      const opts = { ...makeDefaultOptions(), organizationId: null, trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.prepare({
        mode: 'code',
        model: 'gpt',
        prompt: 'hello',
      });
      expect(trpc.cloudAgentNext.prepareSession.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'code', model: 'gpt', prompt: 'hello' }),
        { context: { skipBatch: true } }
      );
    });

    it('calls org prepareSession when organizationId is set', async () => {
      const trpc = makeTrpcMock();
      const opts = {
        ...makeDefaultOptions(),
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
        trpcClient: trpc as never,
      };
      createExtensionAgentSessionManager(opts);
      await capturedConfig!.prepare({
        mode: 'code',
        model: 'gpt',
        prompt: 'hello',
      });
      expect(trpc.organizations.cloudAgentNext.prepareSession.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'code',
          model: 'gpt',
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
          prompt: 'hello',
        }),
        { context: { skipBatch: true } }
      );
    });

    it('throws clear v1 error when initialPayload is provided', async () => {
      const opts = makeDefaultOptions();
      createExtensionAgentSessionManager(opts);
      await expect(
        capturedConfig!.prepare({
          initialPayload: {
            mode: 'code',
            model: 'gpt',
            prompt: 'hi',
            type: 'prompt',
          } as never,
          mode: 'code',
          model: 'gpt',
          prompt: 'hello',
        })
      ).rejects.toThrow('initialPayload is not supported in extension v1 sessions');
    });

    it('returns cloudAgentSessionId and kiloSessionId', async () => {
      const trpc = makeTrpcMock();
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const result = await capturedConfig!.prepare({ mode: 'code', model: 'gpt', prompt: 'hi' });
      expect(result.cloudAgentSessionId).toBe(CLOUD_AGENT_ID);
      expect(result.kiloSessionId).toBe(SESSION_ID);
    });
  });

  describe('initiate', () => {
    it('calls personal initiateFromPreparedSession when organizationId is null', async () => {
      const trpc = makeTrpcMock();
      const opts = { ...makeDefaultOptions(), organizationId: null, trpcClient: trpc as never };
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
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
        trpcClient: trpc as never,
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
        associatedPr: null,
        cloud_agent_session_id: CLOUD_AGENT_ID,
        created_on_platform: 'web',
        git_branch: 'main',
        git_url: 'https://github.com/user/repo',
        organization_id: null,
        runtimeState: {
          githubRepo: 'user/repo',
          initialMessageId: 'init-msg',
          initiatedAt: '2026-01-01',
          mode: 'code',
          model: 'gpt-4',
          preparedAt: '2026-01-01',
          prompt: 'do stuff',
          runtimeAgents: [{ name: 'Ask', slug: 'ask' }],
          upstreamBranch: 'feature/x',
          variant: 'thinking',
        },
        session_id: SESSION_ID,
        title: 'My session',
        total_cost_microdollars: 1500,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data).toMatchObject({
        cloudAgentSessionId: CLOUD_AGENT_ID,
        createdOnPlatform: 'web',
        gitBranch: 'feature/x',
        gitUrl: 'https://github.com/user/repo',
        initialMessageId: 'init-msg',
        isInitiated: true,
        isPreparingAsync: false,
        kiloSessionId: SESSION_ID,
        mode: 'code',
        model: 'gpt-4',
        needsLegacyPrepare: false,
        organizationId: null,
        prompt: 'do stuff',
        repository: 'user/repo',
        title: 'My session',
        totalCostMicrodollars: 1500,
        variant: 'thinking',
      });
      expect(data.runtimeAgents).toStrictEqual([{ name: 'Ask', slug: 'ask' }]);
    });

    it('maps needsLegacyPrepare when cloud_agent_session_id exists but no runtimeState', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = mockQuery({
        associatedPr: null,
        cloud_agent_session_id: CLOUD_AGENT_ID,
        created_on_platform: 'cli',
        git_branch: null,
        git_url: null,
        organization_id: null,
        runtimeState: null,
        session_id: SESSION_ID,
        title: null,
        total_cost_microdollars: null,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.needsLegacyPrepare).toBe(true);
    });

    it('sets needsLegacyPrepare false when cloud_agent_session_id is empty string', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = mockQuery({
        associatedPr: null,
        cloud_agent_session_id: '',
        created_on_platform: 'cli',
        git_branch: null,
        git_url: null,
        organization_id: null,
        runtimeState: null,
        session_id: SESSION_ID,
        title: null,
        total_cost_microdollars: null,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.needsLegacyPrepare).toBe(false);
    });

    it('sets isPreparingAsync true when runtimeState exists but preparedAt is missing', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = mockQuery({
        associatedPr: null,
        cloud_agent_session_id: CLOUD_AGENT_ID,
        created_on_platform: 'web',
        git_branch: null,
        git_url: null,
        organization_id: null,
        runtimeState: {
          mode: 'code',
          model: 'gpt-4',
          prompt: 'do stuff',
        },
        session_id: SESSION_ID,
        title: 'preparing',
        total_cost_microdollars: null,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.isPreparingAsync).toBe(true);
      expect(data.isInitiated).toBe(false);
    });

    it('sets isPreparingAsync true when runtimeState has preparedAt: null', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = mockQuery({
        associatedPr: null,
        cloud_agent_session_id: CLOUD_AGENT_ID,
        created_on_platform: 'web',
        git_branch: null,
        git_url: null,
        organization_id: null,
        runtimeState: {
          mode: 'code',
          model: 'gpt-4',
          preparedAt: null,
          prompt: 'do stuff',
        },
        session_id: SESSION_ID,
        title: 'preparing',
        total_cost_microdollars: null,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.isPreparingAsync).toBe(true);
      expect(data.isInitiated).toBe(false);
    });

    it('uses git_branch when runtimeState has no upstreamBranch', async () => {
      const trpc = makeTrpcMock();
      trpc.cliSessionsV2.getWithRuntimeState.query = mockQuery({
        associatedPr: null,
        cloud_agent_session_id: null,
        created_on_platform: 'cli',
        git_branch: 'fallback-branch',
        git_url: null,
        organization_id: null,
        runtimeState: { mode: 'code', model: 'gpt' },
        session_id: SESSION_ID,
        title: null,
        total_cost_microdollars: null,
      });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.gitBranch).toBe('fallback-branch');
    });

    it('retries on NOT_FOUND and succeeds on a later attempt', async () => {
      const trpc = makeTrpcMock();
      vi.spyOn(trpc.cliSessionsV2.getWithRuntimeState, 'query')
        .mockRejectedValueOnce(notFoundError())
        .mockRejectedValueOnce(notFoundError())
        .mockResolvedValue({
          associatedPr: null,
          cloud_agent_session_id: null,
          created_on_platform: 'cli',
          git_branch: null,
          git_url: null,
          organization_id: null,
          runtimeState: null,
          session_id: SESSION_ID,
          title: 'found',
          total_cost_microdollars: null,
        });
      const opts = { ...makeDefaultOptions(), trpcClient: trpc as never };
      createExtensionAgentSessionManager(opts);
      const data = await capturedConfig!.fetchSession(SESSION_ID);
      expect(data.title).toBe('found');
    });
  });
});
