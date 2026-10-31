import { NextRequest } from 'next/server';

const mockFindFirst = jest.fn();
let mockProbeSecret = 'test-probe-secret';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  get UPTIME_PROBE_SECRET() {
    return mockProbeSecret;
  },
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => {
  const { sql } = jest.requireActual('drizzle-orm');
  const rejectPrimaryRead = () => {
    throw new Error('the uptime probe must not run on the write primary');
  };
  return {
    sql,
    readDb: {
      query: { microdollar_usage: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
    },
    db: {
      query: { microdollar_usage: { findFirst: rejectPrimaryRead } },
      transaction: rejectPrimaryRead,
      execute: rejectPrimaryRead,
    },
  };
});

import { captureException } from '@sentry/nextjs';
import { GET } from './route';

function makeRequest(token: string | null = 'test-probe-secret') {
  return new NextRequest('http://localhost:3000/api/up', {
    method: 'GET',
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
}

const UNHEALTHY = { database: false, recentAIActivity: false };

describe('GET /api/up', () => {
  let clock = Date.now();

  beforeEach(() => {
    clock += 61_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    mockFindFirst.mockReset();
    mockProbeSecret = 'test-probe-secret';
    jest.mocked(captureException).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a caller without the probe credential', async () => {
    const response = await GET(makeRequest(null));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(UNHEALTHY);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a caller with a different credential', async () => {
    const response = await GET(makeRequest('different-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(UNHEALTHY);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('rejects every caller when the credential is not configured', async () => {
    mockProbeSecret = '';
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(UNHEALTHY);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('reports healthy when recent usage is visible', async () => {
    mockFindFirst.mockResolvedValue({ id: 'usage-1' });

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ database: true, recentAIActivity: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it('reports 503 when no recent usage is visible', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const response = await GET(makeRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ database: true, recentAIActivity: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reuses the evaluated result until the interval expires', async () => {
    mockFindFirst.mockResolvedValue({ id: 'usage-1' });
    const first = await GET(makeRequest());
    expect(first.status).toBe(200);

    mockFindFirst.mockResolvedValue(undefined);
    clock += 59_999;
    const retained = await GET(makeRequest());
    expect(retained.status).toBe(200);
    await expect(retained.json()).resolves.toEqual({ database: true, recentAIActivity: true });
    expect(mockFindFirst).toHaveBeenCalledTimes(1);

    clock += 1;
    const refreshed = await GET(makeRequest());
    expect(refreshed.status).toBe(503);
    await expect(refreshed.json()).resolves.toEqual({ database: true, recentAIActivity: false });
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
  });

  it('shares one evaluation between concurrent requests', async () => {
    const { promise, resolve } = Promise.withResolvers<{ id: string } | undefined>();
    mockFindFirst.mockReturnValue(promise);

    const first = GET(makeRequest());
    const second = GET(makeRequest());
    resolve({ id: 'usage-1' });

    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it('reports 503 and captures the error when the read fails', async () => {
    const failure = new Error('connection terminated');
    mockFindFirst.mockRejectedValue(failure);

    const response = await GET(makeRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(UNHEALTHY);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(captureException).toHaveBeenCalledWith(failure, {
      tags: { endpoint: 'up', source: 'uptime_probe' },
    });
  });

  it('also reuses a failed evaluation until the interval expires', async () => {
    mockFindFirst.mockRejectedValue(new Error('connection terminated'));
    expect((await GET(makeRequest())).status).toBe(503);

    mockFindFirst.mockResolvedValue({ id: 'usage-1' });
    clock += 59_999;
    const retained = await GET(makeRequest());
    expect(retained.status).toBe(503);
    await expect(retained.json()).resolves.toEqual(UNHEALTHY);
    expect(mockFindFirst).toHaveBeenCalledTimes(1);

    clock += 1;
    expect((await GET(makeRequest())).status).toBe(200);
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
  });
});
