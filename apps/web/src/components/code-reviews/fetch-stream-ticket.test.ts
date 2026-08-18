import { fetchStreamTicket } from './fetch-stream-ticket';

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('fetchStreamTicket', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns the ticket and expiresAt from a 200 response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: 't', expiresAt: 123 }),
    });

    await expect(fetchStreamTicket('session-1', 'org-1')).resolves.toEqual({
      ticket: 't',
      expiresAt: 123,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/cloud-agent-next/sessions/stream-ticket',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudAgentSessionId: 'session-1', organizationId: 'org-1' }),
      })
    );
  });

  it('throws when the response is missing expiresAt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: 't' }),
    });

    await expect(fetchStreamTicket('session-1')).rejects.toThrow(
      'Missing expiresAt in stream-ticket response'
    );
  });

  it('throws when the response is missing ticket', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ expiresAt: 123 }),
    });

    await expect(fetchStreamTicket('session-1')).rejects.toThrow(
      'Missing ticket in stream-ticket response'
    );
  });

  it('throws the server error from a non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'boom' }),
    });

    await expect(fetchStreamTicket('session-1')).rejects.toThrow('boom');
  });
});
