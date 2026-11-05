import { describe, expect, it, jest } from '@jest/globals';
import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSdkStoredMessage,
  type KiloSessionId,
  type CloudAgentSessionId,
} from '@kilocode/cloud-agent-sdk';
import {
  fetchWebCloudSessionSnapshotPage,
  fetchWebSessionSnapshotPage,
  type CloudSessionPageTrpcClient,
  type SessionPageTrpcClient,
} from './session-page-adapter';

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
    nextCursor: 'older',
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
    await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, { cursor: 'older', limit: 20 });
    expect(fixture.personal).toHaveBeenNthCalledWith(1, { sessionId });
    expect(fixture.personal).toHaveBeenNthCalledWith(2, { sessionId, cursor: 'older', limit: 20 });
    expect(fixture.organization).not.toHaveBeenCalled();
    expect(fixture.ingest).not.toHaveBeenCalled();
  });

  it('keeps organization scope on the DO proxy without calling the ingest router', async () => {
    const fixture = client();
    await fetchWebCloudSessionSnapshotPage(fixture.trpc, sessionId, {
      organizationId: 'org-1',
      cursor: 'older',
    });
    expect(fixture.organization).toHaveBeenCalledWith({
      sessionId,
      cursor: 'older',
      organizationId: 'org-1',
    });
    expect(fixture.personal).not.toHaveBeenCalled();
    expect(fixture.ingest).not.toHaveBeenCalled();
  });

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
        kiloSessionId: childId,
        cursor: 'child-older',
      };
      if (organizationId) {
        expect(fixture.organization).toHaveBeenCalledWith({ ...input, organizationId });
      } else {
        expect(fixture.personal).toHaveBeenCalledWith(input);
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
});

describe('fetchWebSessionSnapshotPage', () => {
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
    expect(query).toHaveBeenCalledWith({ session_id: 'ses_123' });
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

    expect(query).toHaveBeenCalledWith({
      session_id: 'ses_123',
      cursor: 'opaque-cursor',
    });
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

    expect(query).toHaveBeenCalledWith({ session_id: 'ses_123' });
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

  it('lets the tRPC input schema default the limit to 50 on the initial read', async () => {
    const query = jest.fn<
      SessionPageTrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']
    >(async () => ({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
    }));

    await fetchWebSessionSnapshotPage(createClient(query), kiloSessionId('ses_123'), {});

    const call = query.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toBeDefined();
    expect(call?.limit).toBeUndefined();
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
