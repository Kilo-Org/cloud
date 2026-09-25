import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { GastownEnv } from '../gastown.worker';

const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: () => ({ select: mocks.select }) }));
import { kiloAuthMiddleware } from './kilo-auth.middleware';
import { orgAuthMiddleware } from './org-auth.middleware';

const secret = 'gastown-null-pepper-synthetic-secret';
const app = new Hono<GastownEnv>();
app.use('*', kiloAuthMiddleware);
app.use('/api/orgs/:orgId/*', orgAuthMiddleware);
app.get('/api/orgs/:orgId/towns', c => c.json({ role: c.get('orgRole') }));
const env = {
  NEXTAUTH_SECRET: secret,
  HYPERDRIVE: { connectionString: 'postgres://unused' },
} as unknown as Env;

async function request(pepper: string | null | undefined) {
  const bearer = await new SignJWT({
    version: 3,
    kiloUserId: 'oauth/legacy-user',
    apiTokenPepper: pepper,
    orgMemberships: [{ orgId: 'org-1', role: 'owner' }],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  return app.request(
    '/api/orgs/org-1/towns',
    { headers: { Authorization: `Bearer ${bearer}` } },
    env
  );
}

function database(
  pepper: string | null | undefined,
  membership = [{ role: 'member' }],
  blockedAt: string | null = null
) {
  mocks.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: async () => [{ pepper, blockedAt, blockedReason: null }] }),
      innerJoin: () => ({ where: () => ({ limit: async () => membership }) }),
    }),
  }));
}

describe('signed legacy Gastown org access with current DB authority', () => {
  beforeEach(() => vi.resetAllMocks());

  it('accepts matching explicit null and uses the current membership instead of cached owner claims', async () => {
    database(null);
    const response = await request(null);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: 'member' });
  });

  it.each([undefined, ''])(
    'rejects a missing/empty signed pepper %j before DB access',
    async pepper => {
      database(null);
      expect((await request(pepper)).status).toBe(401);
      expect(mocks.select).not.toHaveBeenCalled();
    }
  );

  it.each([
    [null, 'rotated'],
    ['old', null],
    [null, undefined],
  ] as const)('rejects signed %j when current pepper is %j', async (signed, current) => {
    database(current);
    expect((await request(signed)).status).toBe(403);
  });

  it.each([{ membership: [] }, { membership: [{ role: 'billing_manager' }] }])(
    'rejects ineligible current membership %j with matching null',
    async ({ membership }) => {
      database(null, membership);
      expect((await request(null)).status).toBe(403);
    }
  );

  it('rejects blocked accounts even with matching null', async () => {
    database(null, [{ role: 'owner' }], '2026-09-14');
    expect((await request(null)).status).toBe(403);
  });
});
