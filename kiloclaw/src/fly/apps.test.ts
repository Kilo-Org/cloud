import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  appNameFromUserId,
  createApp,
  getApp,
  deleteApp,
  allocateIP,
  AppNameCollisionError,
} from './apps';
import { FlyApiError } from './client';

// ============================================================================
// appNameFromUserId (pure, no mocking needed)
// ============================================================================

describe('appNameFromUserId', () => {
  it('returns a deterministic app name', async () => {
    const name1 = await appNameFromUserId('user-123');
    const name2 = await appNameFromUserId('user-123');
    expect(name1).toBe(name2);
  });

  it('starts with acct- prefix', async () => {
    const name = await appNameFromUserId('user-123');
    expect(name).toMatch(/^acct-/);
  });

  it('is exactly 25 chars (acct- + 20 hex chars)', async () => {
    const name = await appNameFromUserId('user-123');
    expect(name).toHaveLength(25);
  });

  it('only contains lowercase hex chars after prefix', async () => {
    const name = await appNameFromUserId('user-123');
    const hex = name.slice(5);
    expect(hex).toMatch(/^[0-9a-f]{20}$/);
  });

  it('produces different names for different userIds', async () => {
    const name1 = await appNameFromUserId('user-1');
    const name2 = await appNameFromUserId('user-2');
    expect(name1).not.toBe(name2);
  });

  it('handles empty string userId', async () => {
    const name = await appNameFromUserId('');
    expect(name).toMatch(/^acct-[0-9a-f]{20}$/);
  });

  it('handles unicode userId', async () => {
    const name = await appNameFromUserId('user-\u00e9\u00e8\u00ea');
    expect(name).toMatch(/^acct-[0-9a-f]{20}$/);
  });

  it('uses prefix when provided', async () => {
    const name = await appNameFromUserId('user-123', 'dev');
    expect(name).toMatch(/^dev-[0-9a-f]{20}$/);
  });

  it('prefix changes the name but not the hash', async () => {
    const plain = await appNameFromUserId('user-123');
    const prefixed = await appNameFromUserId('user-123', 'dev');
    // Same hash portion, different prefix
    expect(plain.slice(5)).toBe(prefixed.slice(4));
  });

  it('omits acct- prefix when custom prefix is provided', async () => {
    const name = await appNameFromUserId('user-123', 'stg');
    expect(name).toMatch(/^stg-[0-9a-f]{20}$/);
    expect(name).not.toContain('acct');
  });
});

// ============================================================================
// REST API functions (fetch-mocked)
// ============================================================================

const TOKEN = 'test-token';
const CONFIG = { apiToken: TOKEN };
const USER_ID = 'user-123';
const METADATA_KEY = 'kiloclaw_user_id';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

function mockFetchText(status: number, body: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
}

/**
 * Mock fetch to return different responses on sequential calls.
 * Each entry is [status, body] — body can be string or object (JSON-serialized).
 */
function mockFetchSequence(responses: Array<[number, unknown]>): void {
  const fn = vi.fn();
  for (const [status, body] of responses) {
    const responseBody = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = typeof body === 'string' ? {} : { 'Content-Type': 'application/json' };
    fn.mockResolvedValueOnce(new Response(responseBody, { status, headers }));
  }
  vi.stubGlobal('fetch', fn);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createApp', () => {
  it('returns FlyApp on 201', async () => {
    mockFetch(201, { id: 'app-123', created_at: 1234567890 });

    const result = await createApp(CONFIG, 'acct-test', 'test-org', USER_ID, METADATA_KEY);

    expect(result).toEqual({ id: 'app-123', created_at: 1234567890 });

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.machines.dev/v1/apps');
    expect(fetchCall[1].method).toBe('POST');
    const sentBody = JSON.parse(fetchCall[1].body);
    expect(sentBody).toEqual({ app_name: 'acct-test', org_slug: 'test-org', network: 'acct-test' });
  });

  it('passes network param matching app name for isolation', async () => {
    mockFetch(201, { id: 'app-123', created_at: 0 });

    await createApp(CONFIG, 'acct-abc123', 'org', USER_ID, METADATA_KEY);

    const sentBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sentBody.network).toBe('acct-abc123');
  });

  it('treats 409 as success when app has no machines (empty app)', async () => {
    // First call: 409 from createApp. Second call: empty machines list.
    mockFetchSequence([
      [409, 'app already exists'],
      [200, []],
    ]);

    const result = await createApp(CONFIG, 'acct-dup', 'org', USER_ID, METADATA_KEY);

    expect(result).toEqual({ id: 'acct-dup', created_at: 0 });
  });

  it('treats 409 as success when machines belong to same user (retry)', async () => {
    mockFetchSequence([
      [409, 'app already exists'],
      [
        200,
        [
          {
            id: 'machine-1',
            name: 'test',
            state: 'started',
            region: 'iad',
            instance_id: 'inst-1',
            created_at: '',
            updated_at: '',
            config: { image: 'test', metadata: { [METADATA_KEY]: USER_ID } },
          },
        ],
      ],
    ]);

    const result = await createApp(CONFIG, 'acct-dup', 'org', USER_ID, METADATA_KEY);

    expect(result).toEqual({ id: 'acct-dup', created_at: 0 });
  });

  it('throws AppNameCollisionError on 409 when machines belong to different user', async () => {
    mockFetchSequence([
      [409, 'app already exists'],
      [
        200,
        [
          {
            id: 'machine-1',
            name: 'test',
            state: 'started',
            region: 'iad',
            instance_id: 'inst-1',
            created_at: '',
            updated_at: '',
            config: { image: 'test', metadata: { [METADATA_KEY]: 'other-user-456' } },
          },
        ],
      ],
    ]);

    await expect(createApp(CONFIG, 'acct-collision', 'org', USER_ID, METADATA_KEY)).rejects.toThrow(
      AppNameCollisionError
    );

    try {
      // Reset mock for second call
      mockFetchSequence([
        [409, 'app already exists'],
        [
          200,
          [
            {
              id: 'machine-1',
              name: 'test',
              state: 'started',
              region: 'iad',
              instance_id: 'inst-1',
              created_at: '',
              updated_at: '',
              config: { image: 'test', metadata: { [METADATA_KEY]: 'other-user-456' } },
            },
          ],
        ],
      ]);
      await createApp(CONFIG, 'acct-collision', 'org', USER_ID, METADATA_KEY);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppNameCollisionError);
      expect((err as AppNameCollisionError).appName).toBe('acct-collision');
      expect((err as AppNameCollisionError).requestingUserId).toBe(USER_ID);
    }
  });

  it('fails open on 409 when machine listing returns an error', async () => {
    // If we can't list machines, treat as normal 409 (same behavior as before)
    mockFetchSequence([
      [409, 'app already exists'],
      [500, 'internal error'],
    ]);

    const result = await createApp(CONFIG, 'acct-dup', 'org', USER_ID, METADATA_KEY);

    expect(result).toEqual({ id: 'acct-dup', created_at: 0 });
  });

  it('treats 409 as success when machines have no metadata (legacy machines)', async () => {
    mockFetchSequence([
      [409, 'app already exists'],
      [
        200,
        [
          {
            id: 'machine-1',
            name: 'test',
            state: 'started',
            region: 'iad',
            instance_id: 'inst-1',
            created_at: '',
            updated_at: '',
            config: { image: 'test' },
          },
        ],
      ],
    ]);

    const result = await createApp(CONFIG, 'acct-dup', 'org', USER_ID, METADATA_KEY);

    expect(result).toEqual({ id: 'acct-dup', created_at: 0 });
  });

  it('throws FlyApiError on non-OK response', async () => {
    mockFetchText(422, 'app name taken');

    try {
      await createApp(CONFIG, 'acct-bad', 'org', USER_ID, METADATA_KEY);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FlyApiError);
      expect((err as FlyApiError).status).toBe(422);
      expect((err as FlyApiError).body).toBe('app name taken');
    }
  });
});

describe('getApp', () => {
  it('returns FlyApp on 200', async () => {
    mockFetch(200, { id: 'app-123', created_at: 100 });

    const result = await getApp(CONFIG, 'acct-test');

    expect(result).toEqual({ id: 'app-123', created_at: 100 });
  });

  it('returns null on 404', async () => {
    mockFetchText(404, 'not found');

    const result = await getApp(CONFIG, 'acct-nonexistent');

    expect(result).toBeNull();
  });

  it('throws FlyApiError on other error status', async () => {
    mockFetchText(500, 'internal error');

    await expect(getApp(CONFIG, 'acct-test')).rejects.toThrow(FlyApiError);
  });
});

describe('deleteApp', () => {
  it('succeeds silently on 200', async () => {
    mockFetchText(200, 'ok');

    await expect(deleteApp(CONFIG, 'acct-test')).resolves.toBeUndefined();
  });

  it('succeeds silently on 404 (already gone)', async () => {
    mockFetchText(404, 'not found');

    await expect(deleteApp(CONFIG, 'acct-gone')).resolves.toBeUndefined();
  });

  it('throws FlyApiError on other error status', async () => {
    mockFetchText(500, 'internal error');

    await expect(deleteApp(CONFIG, 'acct-test')).rejects.toThrow(FlyApiError);
  });
});

// ============================================================================
// IP allocation (REST)
// ============================================================================

describe('allocateIP', () => {
  it('returns IPAssignment on success', async () => {
    mockFetch(200, {
      ip: '2a09:8280:1::1',
      region: 'global',
      created_at: '2026-01-01T00:00:00Z',
      shared: false,
    });

    const result = await allocateIP(TOKEN, 'acct-test', 'v6');

    expect(result.ip).toBe('2a09:8280:1::1');
    expect(result.region).toBe('global');

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.machines.dev/v1/apps/acct-test/ip_assignments');
    expect(fetchCall[1].method).toBe('POST');
    const sentBody = JSON.parse(fetchCall[1].body);
    expect(sentBody).toEqual({ type: 'v6' });
  });

  it('sends shared_v4 type for IPv4', async () => {
    mockFetch(200, {
      ip: '137.66.1.1',
      region: 'global',
      created_at: '2026-01-01T00:00:00Z',
      shared: true,
    });

    await allocateIP(TOKEN, 'acct-test', 'shared_v4');

    const sentBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(sentBody.type).toBe('shared_v4');
  });

  it('treats 409 as success (IP already allocated)', async () => {
    mockFetchText(409, 'already allocated');

    const result = await allocateIP(TOKEN, 'acct-test', 'v6');

    expect(result.shared).toBe(false);
  });

  it('treats 422 as success (IP already allocated)', async () => {
    mockFetchText(422, 'already allocated');

    const result = await allocateIP(TOKEN, 'acct-test', 'shared_v4');

    expect(result.shared).toBe(true);
  });

  it('throws FlyApiError on 404 (app not found)', async () => {
    mockFetchText(404, 'app not found');

    try {
      await allocateIP(TOKEN, 'acct-nonexistent', 'v6');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FlyApiError);
      expect((err as FlyApiError).status).toBe(404);
    }
  });

  it('throws FlyApiError on 401 (unauthorized)', async () => {
    mockFetchText(401, 'unauthorized');

    try {
      await allocateIP(TOKEN, 'acct-test', 'v6');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FlyApiError);
      expect((err as FlyApiError).status).toBe(401);
    }
  });

  it('throws FlyApiError on 500', async () => {
    mockFetchText(500, 'internal error');

    await expect(allocateIP(TOKEN, 'acct-test', 'v6')).rejects.toThrow(FlyApiError);
  });

  it('encodes app name in URL path', async () => {
    mockFetch(200, {
      ip: '::1',
      region: 'global',
      created_at: '2026-01-01T00:00:00Z',
      shared: false,
    });

    await allocateIP(TOKEN, 'acct-test', 'v6');

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain('/v1/apps/acct-test/ip_assignments');
  });
});
