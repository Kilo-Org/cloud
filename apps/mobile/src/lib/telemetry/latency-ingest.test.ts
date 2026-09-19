import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { postLatencyBatch, resolveLatencyIngestUrl } from '@/lib/telemetry/latency-ingest';
import { type LatencyBatch, type LatencySample } from '@/lib/telemetry/request-latency';

// A mutable config so one suite can flip the endpoint to "unset" without a
// second module registry; the mock's getter keeps the module binding live.
const config = vi.hoisted(() => ({
  latencyIngestUrl: 'https://latency.kiloapps.io' as string | undefined,
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/config', () => ({
  get LATENCY_INGEST_URL() {
    return config.latencyIngestUrl;
  },
}));

vi.mock('@/lib/auth/auth-header', () => ({
  buildAuthHeaders: (token: string | null) =>
    token === null ? {} : { Authorization: `Bearer ${token}` },
}));

vi.mock('@/lib/client-metadata', () => ({
  buildClientMetadataHeaders: () => ({
    'x-kilo-client': 'mobile',
    'x-kilo-app-platform': 'ios',
    'x-kilo-app-version': '1.2.3',
  }),
}));

vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: vi.fn().mockResolvedValue('session-token'),
}));

const SAMPLES: LatencySample[] = [
  {
    requestId: 'req-1',
    procedures: ['user.getMe'],
    ttfbMs: 12,
    totalMs: 34,
    status: 200,
    ok: true,
  },
  {
    requestId: 'req-2',
    procedures: ['activeSessions.list', 'kiloPass.getState'],
    ttfbMs: 8,
    totalMs: 21,
    status: 200,
    ok: true,
  },
];

function batch(samples: LatencySample[] = SAMPLES): LatencyBatch {
  return { samples };
}

function firstFetchCall(): { url: string; init: RequestInit; body: string } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, body: init.body as string };
}

describe('postLatencyBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.latencyIngestUrl = 'https://latency.kiloapps.io';
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the batch to the ingest worker path with the auth and client headers', async () => {
    await postLatencyBatch(batch());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = firstFetchCall();
    expect(url).toBe('https://latency.kiloapps.io/v1/latency');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      Authorization: 'Bearer session-token',
      'x-kilo-client': 'mobile',
      'x-kilo-app-platform': 'ios',
      'x-kilo-app-version': '1.2.3',
    });
    expect(JSON.parse(body)).toEqual({ samples: SAMPLES });
  });

  it('never includes a userId in the payload', async () => {
    await postLatencyBatch(batch());

    const { body } = firstFetchCall();
    expect(body).not.toContain('userId');
  });

  it('posts nothing when the endpoint is unset', async () => {
    config.latencyIngestUrl = undefined;

    await postLatencyBatch(batch());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts nothing for an empty batch', async () => {
    await postLatencyBatch({ samples: [] });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves without throwing when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(postLatencyBatch(batch())).resolves.toBeUndefined();
  });
});

describe('resolveLatencyIngestUrl', () => {
  it('appends the ingest path to the service base URL', () => {
    expect(resolveLatencyIngestUrl('http://192.168.1.5:8816')).toBe(
      'http://192.168.1.5:8816/v1/latency'
    );
    expect(resolveLatencyIngestUrl('https://latency.kiloapps.io')).toBe(
      'https://latency.kiloapps.io/v1/latency'
    );
  });

  it('is idempotent on an already-resolved URL', () => {
    expect(resolveLatencyIngestUrl('https://latency.kiloapps.io/v1/latency')).toBe(
      'https://latency.kiloapps.io/v1/latency'
    );
    expect(resolveLatencyIngestUrl('http://192.168.1.5:8816/v1/latency')).toBe(
      'http://192.168.1.5:8816/v1/latency'
    );
  });

  it('falls back to the base when it is not a parseable URL', () => {
    expect(resolveLatencyIngestUrl('not a url')).toBe('not a url');
  });
});
