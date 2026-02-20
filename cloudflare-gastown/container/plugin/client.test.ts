import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GastownClient, GastownApiError, createClientFromEnv } from './client';
import type { GastownEnv } from './types';

const TEST_ENV: GastownEnv = {
  apiUrl: 'https://gastown.example.com',
  sessionToken: 'test-jwt-token',
  agentId: 'agent-111',
  rigId: 'rig-222',
};

function mockFetch(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => ({ success: true, data }),
  });
}

function mockFetchError(error: string, status = 400) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => ({ success: false, error }),
  });
}

describe('GastownClient', () => {
  let client: GastownClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new GastownClient(TEST_ENV);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends Authorization header with JWT token', async () => {
    const fetchMock = mockFetch({
      agent: {},
      hooked_bead: null,
      undelivered_mail: [],
      open_beads: [],
    });
    globalThis.fetch = fetchMock;

    await client.prime();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gastown.example.com/api/rigs/rig-222/agents/agent-111/prime');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-jwt-token');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('prime() calls the correct endpoint', async () => {
    const primeData = {
      agent: {
        id: 'agent-111',
        role: 'polecat',
        name: 'test',
        identity: 'test-id',
        status: 'idle',
      },
      hooked_bead: null,
      undelivered_mail: [],
      open_beads: [],
    };
    globalThis.fetch = mockFetch(primeData);

    const result = await client.prime();
    expect(result).toEqual(primeData);
  });

  it('getBead() calls the correct endpoint', async () => {
    const bead = { id: 'bead-1', type: 'issue', status: 'open', title: 'Test' };
    globalThis.fetch = mockFetch(bead);

    const result = await client.getBead('bead-1');
    expect(result).toEqual(bead);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://gastown.example.com/api/rigs/rig-222/beads/bead-1');
  });

  it('closeBead() sends agent_id in body', async () => {
    const bead = { id: 'bead-1', status: 'closed' };
    globalThis.fetch = mockFetch(bead);

    await client.closeBead('bead-1');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://gastown.example.com/api/rigs/rig-222/beads/bead-1/close');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ agent_id: 'agent-111' });
  });

  it('done() posts to the agent done endpoint', async () => {
    globalThis.fetch = mockFetch(undefined);

    await client.done({
      branch: 'feat/test',
      pr_url: 'https://github.com/pr/1',
      summary: 'did stuff',
    });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://gastown.example.com/api/rigs/rig-222/agents/agent-111/done');
    expect(JSON.parse(init.body as string)).toEqual({
      branch: 'feat/test',
      pr_url: 'https://github.com/pr/1',
      summary: 'did stuff',
    });
  });

  it('sendMail() includes from_agent_id automatically', async () => {
    globalThis.fetch = mockFetch(undefined);

    await client.sendMail({ to_agent_id: 'agent-222', subject: 'hi', body: 'hello' });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      from_agent_id: 'agent-111',
      to_agent_id: 'agent-222',
      subject: 'hi',
      body: 'hello',
    });
  });

  it('checkMail() calls the correct endpoint', async () => {
    const mail = [{ id: 'mail-1', subject: 'test' }];
    globalThis.fetch = mockFetch(mail);

    const result = await client.checkMail();
    expect(result).toEqual(mail);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://gastown.example.com/api/rigs/rig-222/agents/agent-111/mail');
  });

  it('writeCheckpoint() posts data to checkpoint endpoint', async () => {
    globalThis.fetch = mockFetch(undefined);

    await client.writeCheckpoint({ step: 3, files: ['a.ts'] });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://gastown.example.com/api/rigs/rig-222/agents/agent-111/checkpoint');
    expect(JSON.parse(init.body as string)).toEqual({ data: { step: 3, files: ['a.ts'] } });
  });

  it('createEscalation() posts to escalations endpoint', async () => {
    const bead = { id: 'esc-1', type: 'escalation', priority: 'high' };
    globalThis.fetch = mockFetch(bead);

    const result = await client.createEscalation({ title: 'blocked', priority: 'high' });
    expect(result).toEqual(bead);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://gastown.example.com/api/rigs/rig-222/escalations');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'blocked', priority: 'high' });
  });

  it('throws GastownApiError on failure response', async () => {
    globalThis.fetch = mockFetchError('Not found', 404);

    await expect(client.getBead('nonexistent')).rejects.toThrow(GastownApiError);
    await expect(client.getBead('nonexistent')).rejects.toThrow(
      'Gastown API error (404): Not found'
    );
  });

  it('throws GastownApiError on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(client.getBead('bead-1')).rejects.toThrow(GastownApiError);
    await expect(client.getBead('bead-1')).rejects.toThrow('Network error: fetch failed');
  });

  it('throws GastownApiError on non-JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    await expect(client.getBead('bead-1')).rejects.toThrow(GastownApiError);
    await expect(client.getBead('bead-1')).rejects.toThrow('Invalid JSON response (HTTP 502)');
  });

  it('throws GastownApiError on unexpected response shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ unexpected: true }),
    });

    await expect(client.getBead('bead-1')).rejects.toThrow(GastownApiError);
    await expect(client.getBead('bead-1')).rejects.toThrow('Unexpected response shape');
  });

  it('handles 204 No Content as success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204 });

    // done() returns void, so 204 should not throw
    await expect(client.done({ branch: 'feat/test' })).resolves.toBeUndefined();
  });

  it('normalizes Headers instances from callers', async () => {
    const fetchMock = mockFetch(undefined);
    globalThis.fetch = fetchMock;

    // Internally request() receives init?.headers — verify it doesn't drop them
    // by calling a method and checking the auth header is still set
    await client.done({ branch: 'test' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-jwt-token');
  });

  it('strips trailing slashes from baseUrl', () => {
    const c = new GastownClient({ ...TEST_ENV, apiUrl: 'https://gastown.example.com///' });
    globalThis.fetch = mockFetch({
      agent: {},
      hooked_bead: null,
      undelivered_mail: [],
      open_beads: [],
    });

    // Verify no double slashes in the URL by calling prime
    void c.prime();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://gastown.example.com/api/rigs/rig-222/agents/agent-111/prime');
  });
});

describe('createClientFromEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates a client when all env vars are set', () => {
    process.env.GASTOWN_API_URL = 'https://gastown.example.com';
    process.env.GASTOWN_SESSION_TOKEN = 'tok';
    process.env.GASTOWN_AGENT_ID = 'agent-1';
    process.env.GASTOWN_RIG_ID = 'rig-1';

    const client = createClientFromEnv();
    expect(client).toBeInstanceOf(GastownClient);
  });

  it('throws when env vars are missing', () => {
    delete process.env.GASTOWN_API_URL;
    delete process.env.GASTOWN_SESSION_TOKEN;
    delete process.env.GASTOWN_AGENT_ID;
    delete process.env.GASTOWN_RIG_ID;

    expect(() => createClientFromEnv()).toThrow('Missing required Gastown environment variables');
  });

  it('lists all missing vars in the error message', () => {
    delete process.env.GASTOWN_API_URL;
    process.env.GASTOWN_SESSION_TOKEN = 'tok';
    delete process.env.GASTOWN_AGENT_ID;
    process.env.GASTOWN_RIG_ID = 'rig-1';

    expect(() => createClientFromEnv()).toThrow('GASTOWN_API_URL, GASTOWN_AGENT_ID');
  });
});
