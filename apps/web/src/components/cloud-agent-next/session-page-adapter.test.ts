import { describe, expect, it, jest } from '@jest/globals';
import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSdkStoredMessage,
  type KiloSessionId,
} from '@kilocode/cloud-agent-sdk';
import { fetchWebSessionSnapshotPage, type SessionPageTrpcClient } from './session-page-adapter';

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
