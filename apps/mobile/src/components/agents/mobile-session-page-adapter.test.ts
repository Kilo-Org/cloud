import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSdkStoredMessage,
  type KiloSessionId,
  type SessionSnapshotPageOutcome,
} from 'cloud-agent-sdk';

const mocks = vi.hoisted(() => ({
  getSessionMessagesPageQuery: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cliSessionsV2: {
      getSessionMessagesPage: { query: mocks.getSessionMessagesPageQuery },
    },
  },
}));

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

async function importAdapter(): Promise<{
  fetchMobileSessionSnapshotPage: (
    kiloSessionId: KiloSessionId,
    options: { cursor?: string }
  ) => Promise<SessionSnapshotPageOutcome>;
}> {
  const adapter = await import('@/components/agents/mobile-session-page-adapter');
  return adapter;
}

describe('fetchMobileSessionSnapshotPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a successful shared history page to SessionSnapshotPageOutcome success', async () => {
    const message = storedMessage();
    const page = historyPage({
      messages: [message],
      nextCursor: 'opaque-cursor',
      omittedItemCount: 2,
    });
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: page,
    });

    const { fetchMobileSessionSnapshotPage } = await importAdapter();
    const result = await fetchMobileSessionSnapshotPage(kiloSessionId('ses_123'), {});

    expect(result).toEqual({
      kind: 'success',
      info: { id: 'ses_123' },
      messages: page.messages,
      nextCursor: 'opaque-cursor',
      omittedItemCount: 2,
    });
    // No `cursor` was supplied, so the tRPC layer must see only `session_id`
    // and let its input schema default the bounded page size to 50.
    expect(mocks.getSessionMessagesPageQuery).toHaveBeenCalledWith({ session_id: 'ses_123' });
  });

  it('forwards the continuation cursor to the tRPC layer as `cursor`', async () => {
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
    });

    const { fetchMobileSessionSnapshotPage } = await importAdapter();
    await fetchMobileSessionSnapshotPage(kiloSessionId('ses_123'), { cursor: 'opaque-cursor' });

    expect(mocks.getSessionMessagesPageQuery).toHaveBeenCalledWith({
      session_id: 'ses_123',
      cursor: 'opaque-cursor',
    });
  });

  it('omits the cursor from the tRPC request when the manager has no continuation', async () => {
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
    });

    const { fetchMobileSessionSnapshotPage } = await importAdapter();
    await fetchMobileSessionSnapshotPage(kiloSessionId('ses_123'), { cursor: '' });

    // An empty cursor must not be forwarded; the tRPC schema would reject
    // a non-positive length string anyway, and the manager only sets
    // `nextCursor: null` once the history is fully read.
    expect(mocks.getSessionMessagesPageQuery).toHaveBeenCalledWith({ session_id: 'ses_123' });
  });

  it('maps a freshly-created cloud-agent session with no messages (BUG 3, history:null) to an empty success page', async () => {
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_new',
      history: null,
    });

    const { fetchMobileSessionSnapshotPage } = await importAdapter();
    await expect(fetchMobileSessionSnapshotPage(kiloSessionId('ses_new'), {})).resolves.toEqual({
      kind: 'success',
      info: { id: 'ses_new' },
      messages: [],
      nextCursor: null,
      omittedItemCount: 0,
    });
  });

  it('maps an existing empty read-only session (BUG 4, history:null) to an empty success page', async () => {
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_readonly_empty',
      history: null,
    });

    const { fetchMobileSessionSnapshotPage } = await importAdapter();
    await expect(
      fetchMobileSessionSnapshotPage(kiloSessionId('ses_readonly_empty'), {})
    ).resolves.toEqual({
      kind: 'success',
      info: { id: 'ses_readonly_empty' },
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
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history,
    });

    const { fetchMobileSessionSnapshotPage } = await importAdapter();
    await expect(fetchMobileSessionSnapshotPage(kiloSessionId('ses_123'), {})).resolves.toEqual({
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

    // Queue every response up-front so the mock implementation is fully
    // deterministic regardless of which adapter call hits the mock first.
    mocks.getSessionMessagesPageQuery.mockReset();
    for (const history of histories) {
      mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
        kiloSessionId: 'ses_123',
        history,
      });
    }

    const { fetchMobileSessionSnapshotPage } = await importAdapter();
    // Two independent adapter calls; the mock queue delivers the matching
    // history to each. `Promise.all` runs them in parallel and the assertion
    // checks the collected results in call order.
    const results = await Promise.all([
      fetchMobileSessionSnapshotPage(kiloSessionId('ses_123'), {}),
      fetchMobileSessionSnapshotPage(kiloSessionId('ses_123'), {}),
    ]);

    expect(results).toEqual(histories);
  });

  it('lets the tRPC input schema default the limit to 50 on the initial read', async () => {
    // The mobile adapter never sets `limit` itself so the shared contract
    // default of 50 always applies. This test pins that contract: any
    // future change here must keep the request bounded by default.
    mocks.getSessionMessagesPageQuery.mockResolvedValueOnce({
      kiloSessionId: 'ses_123',
      history: historyPage({ nextCursor: null }),
    });

    const { fetchMobileSessionSnapshotPage } = await importAdapter();
    await fetchMobileSessionSnapshotPage(kiloSessionId('ses_123'), {});

    const call = mocks.getSessionMessagesPageQuery.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toBeDefined();
    expect(call.limit).toBeUndefined();
  });
});
