import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createReviewSpectatorStream } from './review-spectator-stream';

const createConnectionMock = vi.hoisted(() => vi.fn());
const getAuthTokenForRequestMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const lifecycleHooksMock = vi.hoisted(() => ({ onVisibilityChange: vi.fn(), onOnline: vi.fn() }));

vi.mock('@kilocode/cloud-agent-sdk', () => ({
  createConnection: createConnectionMock,
}));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: getAuthTokenForRequestMock,
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: () => lifecycleHooksMock,
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));

const ticketResponse = { ticket: 't-1', expiresAt: 123 };

function noopCallback(): void {
  // no-op stream callback; the tests only assert the createConnection config
}

function okTicketResponseFetchInit() {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(ticketResponse),
  };
}

beforeEach(() => {
  createConnectionMock.mockReset();
  createConnectionMock.mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    retryReconnect: vi.fn(),
    destroy: vi.fn(),
  });
  getAuthTokenForRequestMock.mockReset();
  getAuthTokenForRequestMock.mockResolvedValue('tok-1');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okTicketResponseFetchInit());
});

describe('createReviewSpectatorStream', () => {
  it('builds a /stream URL with the session id, no ticket param, and the web Origin', async () => {
    vi.stubGlobal('fetch', fetchMock);

    const connection = await createReviewSpectatorStream({
      cloudAgentSessionId: 'agent-1',
      organizationId: 'org-1',
      onEvent: noopCallback,
      onConnected: noopCallback,
      onReconnected: noopCallback,
      onDisconnected: noopCallback,
      onError: noopCallback,
    });

    expect(connection).toBeDefined();
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    const config = createConnectionMock.mock.calls[0]?.[0] as {
      websocketUrl: string;
      ticket: unknown;
      websocketHeaders: Record<string, string>;
      lifecycleHooks: unknown;
      onRefreshTicket: () => Promise<unknown>;
    };

    const wsUrl = new URL(config.websocketUrl);
    expect(wsUrl.pathname).toBe('/stream');
    expect(wsUrl.searchParams.get('cloudAgentSessionId')).toBe('agent-1');
    expect(wsUrl.searchParams.get('ticket')).toBeNull();
    expect(config.websocketHeaders).toEqual({ Origin: 'https://web.test' });
    expect(config.ticket).toEqual(ticketResponse);
    // Without these the stream misses AppState resume and offline-to-online recovery.
    expect(config.lifecycleHooks).toBe(lifecycleHooksMock);

    const refreshed = await config.onRefreshTicket();
    expect(refreshed).toEqual(ticketResponse);
    vi.unstubAllGlobals();
  });

  it('posts the ticket to the same stream-ticket route as the session manager', async () => {
    vi.stubGlobal('fetch', fetchMock);

    await createReviewSpectatorStream({
      cloudAgentSessionId: 'agent-1',
      organizationId: 'org-1',
      onEvent: noopCallback,
      onConnected: noopCallback,
      onReconnected: noopCallback,
      onDisconnected: noopCallback,
      onError: noopCallback,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/cloud-agent-next/sessions/stream-ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-1',
        },
        body: JSON.stringify({ cloudAgentSessionId: 'agent-1', organizationId: 'org-1' }),
      }
    );
    vi.unstubAllGlobals();
  });

  it('omits organizationId from the ticket body when it is an empty string', async () => {
    vi.stubGlobal('fetch', fetchMock);

    await createReviewSpectatorStream({
      cloudAgentSessionId: 'agent-1',
      organizationId: '',
      onEvent: noopCallback,
      onConnected: noopCallback,
      onReconnected: noopCallback,
      onDisconnected: noopCallback,
      onError: noopCallback,
    });

    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? 'null') as Record<string, unknown>;
    expect(body).toEqual({ cloudAgentSessionId: 'agent-1' });
    vi.unstubAllGlobals();
  });
});
