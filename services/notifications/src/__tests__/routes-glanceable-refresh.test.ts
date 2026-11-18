import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsService } from '../index';

const TEST_INTERNAL_SECRET = 'test-internal-api-secret';

type Scope = { userId: string; organizationId: string | null };

function setupRoute() {
  const refreshes: Scope[] = [];
  const serviceEnv = {
    INTERNAL_API_SECRET: { get: async () => TEST_INTERNAL_SECRET },
    NOTIFICATION_CHANNEL_DO: {
      idFromName: (userId: string) => userId,
      get: () => ({
        refreshGlanceableSnapshot: async (scope: Scope) => {
          refreshes.push(scope);
        },
      }),
    },
  };
  const service = new NotificationsService(createExecutionContext(), serviceEnv as never);
  const post = (options: { secret?: string | null; body?: unknown }) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.secret !== null && options.secret !== undefined) {
      headers['X-Internal-Secret'] = options.secret;
    }
    return service.fetch(
      new Request('https://example.com/internal/v1/glanceable-refresh', {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body ?? { userId: 'user-a', organizationId: null }),
      })
    );
  };
  return { post, refreshes };
}

describe('POST /internal/v1/glanceable-refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when X-Internal-Secret header is missing', async () => {
    const { post, refreshes } = setupRoute();

    const res = await post({ secret: null, body: { userId: 'user-a', organizationId: null } });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(refreshes).toEqual([]);
  });

  it('returns 401 when X-Internal-Secret is wrong', async () => {
    const { post, refreshes } = setupRoute();

    const res = await post({
      secret: 'wrong-secret',
      body: { userId: 'user-a', organizationId: null },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(refreshes).toEqual([]);
  });

  it('returns 400 when the body is not a scope', async () => {
    const { post, refreshes } = setupRoute();

    const res = await post({ secret: TEST_INTERNAL_SECRET, body: { userId: '' } });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid body' });
    expect(refreshes).toEqual([]);
  });

  it('refreshes the personal scope and answers ok', async () => {
    const { post, refreshes } = setupRoute();

    const res = await post({
      secret: TEST_INTERNAL_SECRET,
      body: { userId: 'user-a', organizationId: null },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(refreshes).toEqual([{ userId: 'user-a', organizationId: null }]);
  });

  it('refreshes the organization scope that the caller names', async () => {
    const { post, refreshes } = setupRoute();

    const res = await post({
      secret: TEST_INTERNAL_SECRET,
      body: { userId: 'user-b', organizationId: 'org-1' },
    });

    expect(res.status).toBe(200);
    expect(refreshes).toEqual([{ userId: 'user-b', organizationId: 'org-1' }]);
  });
});
