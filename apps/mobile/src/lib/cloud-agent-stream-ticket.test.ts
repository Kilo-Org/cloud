import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchCloudAgentStreamTicket } from './cloud-agent-stream-ticket';

const getAuthTokenForRequestMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: getAuthTokenForRequestMock,
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
}));

function okResponse(body: unknown): { ok: boolean; json: () => Promise<unknown> } {
  return { ok: true, json: vi.fn().mockResolvedValue(body) };
}

function errorResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

beforeEach(() => {
  getAuthTokenForRequestMock.mockReset();
  getAuthTokenForRequestMock.mockResolvedValue('tok-1');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCloudAgentStreamTicket', () => {
  it('POSTs the stream-ticket route with the bearer header and org body', async () => {
    fetchMock.mockResolvedValue(okResponse({ ticket: 't-1', expiresAt: 123 }));

    await expect(fetchCloudAgentStreamTicket('agent-1', 'org-1')).resolves.toEqual({
      ticket: 't-1',
      expiresAt: 123,
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
  });

  it('omits the Authorization header when no token is held', async () => {
    getAuthTokenForRequestMock.mockResolvedValue(null);
    fetchMock.mockResolvedValue(okResponse({ ticket: 't-1', expiresAt: 123 }));

    await fetchCloudAgentStreamTicket('agent-1');

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('omits an empty-string organizationId from the body', async () => {
    fetchMock.mockResolvedValue(okResponse({ ticket: 't-1', expiresAt: 123 }));

    await fetchCloudAgentStreamTicket('agent-1', '');

    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ cloudAgentSessionId: 'agent-1' });
  });

  it('throws the server error message when the response is not ok', async () => {
    fetchMock.mockResolvedValue(errorResponse(500, { error: 'server exploded' }));

    await expect(fetchCloudAgentStreamTicket('agent-1')).rejects.toThrow('server exploded');
  });

  it('falls back to the generic message when a failed response carries no error', async () => {
    fetchMock.mockResolvedValue(errorResponse(500, {}));

    await expect(fetchCloudAgentStreamTicket('agent-1')).rejects.toThrow(
      'Failed to get stream ticket'
    );
  });

  it('throws when ticket is missing from an ok response', async () => {
    fetchMock.mockResolvedValue(okResponse({ expiresAt: 123 }));

    await expect(fetchCloudAgentStreamTicket('agent-1')).rejects.toThrow(
      'Missing ticket in stream-ticket response'
    );
  });

  it('throws when expiresAt is missing from an ok response', async () => {
    fetchMock.mockResolvedValue(okResponse({ ticket: 't-1' }));

    await expect(fetchCloudAgentStreamTicket('agent-1')).rejects.toThrow(
      'Missing expiresAt in stream-ticket response'
    );
  });

  it('rejects a non-string ticket through the zod contract', async () => {
    fetchMock.mockResolvedValue(okResponse({ ticket: 123, expiresAt: 123 }));

    await expect(fetchCloudAgentStreamTicket('agent-1')).rejects.toThrow();
  });
});
