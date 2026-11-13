import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSdkStoredMessage,
  type KiloSessionId,
  type CloudAgentSessionId,
} from '@kilocode/cloud-agent-sdk';
import type * as SessionPageAdapter from './session-page-adapter';
import type { CloudSessionPageTrpcClient, SessionPageTrpcClient } from './session-page-adapter';

const mockCaptureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

let fetchWebCloudSessionSnapshotPage: typeof SessionPageAdapter.fetchWebCloudSessionSnapshotPage;
let fetchWebSessionSnapshotPage: typeof SessionPageAdapter.fetchWebSessionSnapshotPage;

beforeAll(async () => {
  ({ fetchWebCloudSessionSnapshotPage, fetchWebSessionSnapshotPage } =
    await import('./session-page-adapter'));
});

const unbatched = { context: { skipBatch: true } };

function kiloSessionId(id: string): KiloSessionId {
  return id as KiloSessionId;
}

function storedMessage(
  overrides: {
    id?: string;
    sessionID?: string;
    created?: number;
    text?: string;
  } = {}
): KiloSdkStoredMessage {
  const id = overrides.id ?? 'msg_user_01';
  const sessionID = overrides.sessionID ?? 'ses_123';
  const created = overrides.created ?? 1_761_000_000_100;
  const text = overrides.text ?? 'hello';

  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    },
    parts: [
      {
        id: `${id}-text`,
        sessionID,
        messageID: id,
        type: 'text',
        text,
      },
    ],
  };
}

function historyPage(
  overrides: Partial<KiloSdkMessageHistoryPage> = {}
): KiloSdkMessageHistoryPage {
  return {
    messages: [],
    nextCursor: null,
    omittedItemCount: 0,
    ...overrides,
  };
}

function createClient(
  query: SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
): SessionPageTrpcClient {
  return {
    cliSessionsV2: {
      getSessionMessagesPage: { query },
    },
  };
}

describe('fetchWebCloudSessionSnapshotPage', () => {
  const sessionId = 'workspace_12345678-1234-4234-9234-123456789abc' as CloudAgentSessionId;
  const page = {
    kind: 'success',
    info: { id: 'ses_12345678901234567890123456' },
    messages: [],
    nextCursor: null,
    omittedItemCount: 0,
    updateCursor: 42,
    totalCostMicrodollars: 350_000,
  };

  function client() {
    const personal = jest.fn<
      CloudSessionPageTrpcClient['cloudAgentNext']['getSessionMessagesPage']['query']
    >(async () => page);
    const organization = jest.fn<
      CloudSessionPageTrpcClient['organizations']['cloudAgentNext']['getSessionMessagesPage']['query']
    >(async () => page);
    const ingest =
      jest.fn<SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']>();
    return {
      trpc: {
        ...createClient(ingest),
        cloudAgentNext: { getSessionMessagesPage: { query: personal } },
        organizations: { cloudAgentNext: { getSessionMessagesPage: { query: organization } } },
      },
      personal,
      organization,
      ingest,
    };
  }

  it('uses only the Cloud Agent personal endpoint for initial and older pages', async () => {
    const fixture = client();
    await expect(fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {})).resolves.toEqual(
      page
    );
    await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, { cursor: 'older' });
    expect(fixture.personal).toHaveBeenNthCalledWith(
      1,
      { sessionId, toolDisplay: 'preview', limit: 20 },
      unbatched
    );
    expect(fixture.personal).toHaveBeenNthCalledWith(
      2,
      { sessionId, toolDisplay: 'preview', cursor: 'older' },
      unbatched
    );
    expect(fixture.organization).not.toHaveBeenCalled();
    expect(fixture.ingest).not.toHaveBeenCalled();
  });

  it.each([undefined, 'org-1'])(
    'requests 20 initial messages for scope %s',
    async organizationId => {
      const fixture = client();
      await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, { organizationId });
      const query = organizationId ? fixture.organization : fixture.personal;
      expect(query.mock.calls).toEqual([
        [
          {
            sessionId,
            toolDisplay: 'preview',
            limit: 20,
            ...(organizationId ? { organizationId } : {}),
          },
          unbatched,
        ],
      ]);
    }
  );

  it.each([undefined, 'org-1'])(
    'preserves explicit initial and older-page limits for scope %s',
    async organizationId => {
      const fixture = client();
      await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, { organizationId, limit: 7 });
      await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {
        organizationId,
        cursor: 'older',
        limit: 12,
      });
      const query = organizationId ? fixture.organization : fixture.personal;
      expect(query.mock.calls).toEqual([
        [
          {
            sessionId,
            toolDisplay: 'preview',
            limit: 7,
            ...(organizationId ? { organizationId } : {}),
          },
          unbatched,
        ],
        [
          {
            sessionId,
            toolDisplay: 'preview',
            cursor: 'older',
            limit: 12,
            ...(organizationId ? { organizationId } : {}),
          },
          unbatched,
        ],
      ]);
    }
  );

  it('keeps organization scope on the DO proxy without calling the ingest router', async () => {
    const fixture = client();
    await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {
      organizationId: 'org-1',
      cursor: 'older',
    });
    expect(fixture.organization).toHaveBeenCalledWith(
      {
        sessionId,
        toolDisplay: 'preview',
        cursor: 'older',
        organizationId: 'org-1',
      },
      unbatched
    );
    expect(fixture.personal).not.toHaveBeenCalled();
    expect(fixture.ingest).not.toHaveBeenCalled();
  });

  it.each([undefined, 'org-1'])(
    'requests 20 initial child messages without changing scope %s',
    async organizationId => {
      const fixture = client();
      const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
      const childPage = { ...page, info: { id: childId, parentID: page.info.id } };
      fixture.personal.mockResolvedValue(childPage);
      fixture.organization.mockResolvedValue(childPage);
      await expect(
        fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {
          organizationId,
          kiloSessionId: childId,
        })
      ).resolves.toEqual(childPage);
      const query = organizationId ? fixture.organization : fixture.personal;
      expect(query.mock.calls).toEqual([
        [
          {
            sessionId,
            toolDisplay: 'preview',
            kiloSessionId: childId,
            limit: 20,
            ...(organizationId ? { organizationId } : {}),
          },
          unbatched,
        ],
      ]);
    }
  );

  it.each([undefined, 'org-1'])(
    'forwards a native child selector through the root DO for scope %s',
    async organizationId => {
      const fixture = client();
      const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
      const childPage = { ...page, info: { id: childId, parentID: page.info.id } };
      fixture.personal.mockResolvedValue(childPage);
      fixture.organization.mockResolvedValue(childPage);
      await expect(
        fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {
          organizationId,
          kiloSessionId: childId,
          cursor: 'child-older',
        })
      ).resolves.toEqual(childPage);
      const input = {
        sessionId,
        toolDisplay: 'preview' as const,
        kiloSessionId: childId,
        cursor: 'child-older',
      };
      if (organizationId) {
        expect(fixture.organization).toHaveBeenCalledWith({ ...input, organizationId }, unbatched);
      } else {
        expect(fixture.personal).toHaveBeenCalledWith(input, unbatched);
      }
      expect(fixture.ingest).not.toHaveBeenCalled();
    }
  );

  it('validates mutation cursors and does not fall back on null or invalid DO results', async () => {
    const fixture = client();
    fixture.personal
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...page, updateCursor: 'wrong' });
    await expect(fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {})).resolves.toBeNull();
    await expect(fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {})).rejects.toThrow();
    expect(fixture.ingest).not.toHaveBeenCalled();
  });

  it.each(['v1', 'v2'] as const)(
    'loads through two user messages across %s pages and preserves the initial stream cursor',
    async version => {
      const fixture = client();
      const source =
        version === 'v1'
          ? { version: 'v1' }
          : {
              version: 'v2',
              session: {
                id: page.info.id,
                location: { directory: '/workspace/fixture' },
                time: { created: 1, updated: 2 },
              },
            };
      const message = (id: string, role: 'user' | 'assistant') =>
        version === 'v1'
          ? { info: { id, role }, parts: [] }
          : { message: { id, type: role, time: { created: 1 } } };
      const latest = message('msg_latest', 'assistant');
      const lastUser = message('msg_user_2', 'user');
      const previousUser = message('msg_user_1', 'user');
      fixture.personal
        .mockResolvedValueOnce({ ...page, source, messages: [latest], nextCursor: 'one' })
        .mockResolvedValueOnce({
          ...page,
          source,
          messages: [lastUser],
          nextCursor: 'two',
          updateCursor: 43,
          omittedItemCount: 1,
        })
        .mockResolvedValueOnce({
          ...page,
          source,
          messages: [previousUser],
          nextCursor: 'three',
          updateCursor: 44,
        });

      const result = await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {});
      expect(result).toMatchObject({
        messages: [previousUser, lastUser, latest],
        nextCursor: 'three',
        updateCursor: 42,
        omittedItemCount: 1,
      });
      expect(fixture.personal).toHaveBeenCalledTimes(3);
      expect(fixture.personal.mock.calls.slice(1).map(([input]) => input)).toEqual([
        { sessionId, toolDisplay: 'preview', cursor: 'one', limit: undefined },
        { sessionId, toolDisplay: 'preview', cursor: 'two', limit: undefined },
      ]);
    }
  );

  it('preserves organization and child scope on every turn-loading request', async () => {
    const fixture = client();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    fixture.organization
      .mockResolvedValueOnce({ ...page, info: { id: childId }, nextCursor: 'older' })
      .mockResolvedValueOnce({ ...page, info: { id: childId } });
    await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {
      organizationId: 'org-1',
      kiloSessionId: childId,
    });
    expect(fixture.organization).toHaveBeenCalledTimes(2);
    for (const [input, options] of fixture.organization.mock.calls) {
      expect(input).toMatchObject({ sessionId, kiloSessionId: childId, organizationId: 'org-1' });
      expect(options).toEqual(unbatched);
    }
    expect(fixture.personal).not.toHaveBeenCalled();
  });

  it('does not read an older page when the first page already contains two user messages', async () => {
    const fixture = client();
    const first = {
      ...page,
      messages: [storedMessage({ id: 'msg_user_1' }), storedMessage({ id: 'msg_user_2' })],
      nextCursor: 'older',
    };
    fixture.personal.mockResolvedValue(first);
    await expect(fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {})).resolves.toEqual(
      first
    );
    expect(fixture.personal).toHaveBeenCalledTimes(1);
  });

  it('does not merge history from another session', async () => {
    const fixture = client();
    const first = { ...page, nextCursor: 'older' };
    fixture.personal
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...page, info: { id: 'ses_another' } });
    await expect(fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {})).resolves.toEqual(
      first
    );
  });

  it('bounds initial turn loading to five pages even without user messages', async () => {
    const fixture = client();
    fixture.personal.mockImplementation(async input => ({
      ...page,
      nextCursor: `${input.cursor ?? 'start'}-older`,
    }));
    const result = await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {});
    expect(fixture.personal).toHaveBeenCalledTimes(5);
    expect(result?.nextCursor).toBe('start-older-older-older-older-older');
  });

  it('keeps a usable partial page and retry cursor when an additional read fails', async () => {
    const fixture = client();
    const first = { ...page, nextCursor: 'retry-here' };
    const failure = new Error('Unavailable');
    mockCaptureException.mockClear();
    fixture.personal.mockResolvedValueOnce(first).mockRejectedValueOnce(failure);
    await expect(fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {})).resolves.toEqual(
      first
    );
    expect(fixture.personal).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything());
  });

  it('keeps the initial page within the SDK retained-message window', async () => {
    const fixture = client();
    const messages = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        info: { id: `${prefix}_${index}`, role: 'assistant' },
        parts: [],
      }));
    const first = { ...page, messages: messages('newer', 160), nextCursor: 'one' };
    const second = { ...page, messages: messages('middle', 30), nextCursor: 'two' };
    fixture.personal
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce({ ...page, messages: messages('older', 11), nextCursor: 'three' });
    const result = await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {});
    expect(result?.messages).toHaveLength(190);
    expect(result?.nextCursor).toBe('two');
    expect(fixture.personal).toHaveBeenCalledTimes(3);
  });

  it('counts v2 synthetic prompts as user turns', async () => {
    const fixture = client();
    const source = {
      version: 'v2',
      session: {
        id: page.info.id,
        location: { directory: '/workspace/fixture' },
        time: { created: 1, updated: 2 },
      },
    };
    const message = (id: string, type: 'user' | 'synthetic') => ({
      message: { id, type, time: { created: 1 } },
    });
    fixture.personal
      .mockResolvedValueOnce({
        ...page,
        source,
        messages: [message('msg_synthetic', 'synthetic')],
        nextCursor: 'one',
      })
      .mockResolvedValueOnce({
        ...page,
        source,
        messages: [message('msg_user', 'user')],
        nextCursor: 'two',
      });
    const result = await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {});
    expect(result?.nextCursor).toBe('two');
    expect(fixture.personal).toHaveBeenCalledTimes(2);
  });

  it('keeps the current cursor when additional history exceeds the byte budget', async () => {
    const fixture = client();
    const first = { ...page, nextCursor: 'large' };
    fixture.personal.mockResolvedValueOnce(first).mockResolvedValueOnce({
      ...page,
      messages: [{ info: {}, parts: [{ text: 'x'.repeat(4 * 1024 * 1024) }] }],
    });
    await expect(fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {})).resolves.toEqual(
      first
    );
    expect(fixture.personal).toHaveBeenCalledTimes(2);
  });

  it('stops repeated cursors without duplicating the returned messages', async () => {
    const fixture = client();
    const first = { ...page, messages: [storedMessage()], nextCursor: 'same' };
    fixture.personal.mockResolvedValue(first);
    await expect(fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {})).resolves.toEqual(
      first
    );
    expect(fixture.personal).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWebSessionSnapshotPage', () => {
  it('loads two recent user turns for CLI history without advancing the initial watermark', async () => {
    const latest = storedMessage({ id: 'user-2' });
    const previous = storedMessage({ id: 'user-1' });
    const query =
      jest.fn<SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']>();
    query
      .mockResolvedValueOnce({
        kiloSessionId: 'ses_123',
        history: historyPage({ messages: [latest], nextCursor: 'older' }),
        watermarkEventId: 42,
      })
      .mockResolvedValueOnce({
        kiloSessionId: 'ses_123',
        history: historyPage({ messages: [previous], nextCursor: 'earlier', omittedItemCount: 1 }),
        watermarkEventId: 43,
      });
    await expect(
      fetchWebSessionSnapshotPage(createClient(query), kiloSessionId('ses_123'), {})
    ).resolves.toMatchObject({
      messages: [previous, latest],
      nextCursor: 'earlier',
      omittedItemCount: 1,
      watermarkEventId: 42,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('maps a successful shared history page to SessionSnapshotPageOutcome success', async () => {
    const message = storedMessage();
    const page = historyPage({
      messages: [message],
      nextCursor: 'opaque-cursor',
      omittedItemCount: 2,
    });
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_123',
      history: page,
      watermarkEventId: 42,
    }));

    const result = await fetchWebSessionSnapshotPage(
      createClient(query),
      kiloSessionId('ses_123'),
      {}
    );

    expect(result).toEqual({
      kind: 'success',
      info: { id: 'ses_123' },
      messages: page.messages,
      nextCursor: 'opaque-cursor',
      omittedItemCount: 2,
      watermarkEventId: 42,
    });
    expect(query).toHaveBeenCalledWith({ session_id: 'ses_123', limit: 20 }, unbatched);
  });

  it('forwards the continuation cursor to the tRPC layer as `cursor`', async () => {
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
    }));

    await fetchWebSessionSnapshotPage(createClient(query), kiloSessionId('ses_123'), {
      cursor: 'opaque-cursor',
    });

    expect(query).toHaveBeenCalledWith(
      {
        session_id: 'ses_123',
        cursor: 'opaque-cursor',
      },
      unbatched
    );
  });

  it('omits the cursor from the tRPC request when the manager has no continuation', async () => {
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
    }));

    await fetchWebSessionSnapshotPage(createClient(query), kiloSessionId('ses_123'), {
      cursor: '',
    });

    expect(query).toHaveBeenCalledWith({ session_id: 'ses_123', limit: 20 }, unbatched);
  });

  it('maps a session with no messages (history:null) to an empty success page', async () => {
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_new',
      history: null,
    }));

    await expect(
      fetchWebSessionSnapshotPage(createClient(query), kiloSessionId('ses_new'), {})
    ).resolves.toEqual({
      kind: 'success',
      info: { id: 'ses_new' },
      messages: [],
      nextCursor: null,
      omittedItemCount: 0,
    });
  });

  it('passes typed retryable_failure through verbatim so the UI can offer Retry', async () => {
    const history: KiloSdkMessageHistory = {
      kind: 'retryable_failure',
      phase: 'page_parts',
    };
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_123',
      history,
    }));

    await expect(
      fetchWebSessionSnapshotPage(createClient(query), kiloSessionId('ses_123'), {})
    ).resolves.toEqual({
      kind: 'retryable_failure',
      phase: 'page_parts',
    });
  });

  it('passes typed too_large and invalid_data failures through verbatim', async () => {
    const histories: KiloSdkMessageHistory[] = [
      {
        kind: 'too_large',
        maximumBytes: 8 * 1024 * 1024,
        phase: 'message_scan',
      },
      { kind: 'invalid_data' },
    ];
    const query =
      jest.fn<SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']>();
    for (const history of histories) {
      query.mockResolvedValueOnce({
        kiloSessionId: 'ses_123',
        history,
      });
    }
    const client = createClient(query);

    const results = await Promise.all([
      fetchWebSessionSnapshotPage(client, kiloSessionId('ses_123'), {}),
      fetchWebSessionSnapshotPage(client, kiloSessionId('ses_123'), {}),
    ]);

    expect(results).toEqual(histories);
  });

  it('uses 20 messages for the initial read, including the server-prefetch adapter', async () => {
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
    }));

    await fetchWebSessionSnapshotPage(createClient(query), kiloSessionId('ses_123'), {});

    expect(query).toHaveBeenCalledWith({ session_id: 'ses_123', limit: 20 }, unbatched);
  });

  it('carries watermarkEventId through when the web router includes it', async () => {
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
      watermarkEventId: 77,
    }));

    const result = await fetchWebSessionSnapshotPage(
      createClient(query),
      kiloSessionId('ses_123'),
      {}
    );

    expect(result).toMatchObject({ kind: 'success', watermarkEventId: 77 });
  });

  it('omits watermarkEventId from the page when the web router does not include it', async () => {
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
    }));

    const result = await fetchWebSessionSnapshotPage(
      createClient(query),
      kiloSessionId('ses_123'),
      {}
    );

    expect(result).toMatchObject({ kind: 'success' });
    expect((result as Record<string, unknown>).watermarkEventId).toBeUndefined();
  });
});
