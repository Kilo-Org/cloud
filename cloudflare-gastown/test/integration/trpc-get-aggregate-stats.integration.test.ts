import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { signKiloToken } from '@kilocode/worker-utils';

const NEXTAUTH_SECRET = 'test-nextauth-secret-at-least-32-chars';

function api(path: string): string {
  return `http://localhost${path}`;
}

async function authHeader(): Promise<Record<string, string>> {
  const { token } = await signKiloToken({
    userId: `user-${crypto.randomUUID()}`,
    pepper: null,
    secret: NEXTAUTH_SECRET,
    expiresInSeconds: 300,
    env: 'development',
    extra: {
      gastownAccess: true,
    },
  });

  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

describe('tRPC getAggregateStats integration', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await SELF.fetch(
      api(`/trpc/gastown.getAggregateStats?input=${encodeURIComponent(JSON.stringify({}))}`),
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    expect(res.status).toBe(401);
  });

  it('returns internal error when HYPERDRIVE is unavailable', async () => {
    const res = await SELF.fetch(
      api(`/trpc/gastown.getAggregateStats?input=${encodeURIComponent(JSON.stringify({}))}`),
      {
        method: 'GET',
        headers: await authHeader(),
      }
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { data: { code: string }; message: string } };

    expect(body.error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error.message).toContain('HYPERDRIVE binding not configured');
  });
});
