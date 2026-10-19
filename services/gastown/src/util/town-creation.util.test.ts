import { Hono } from 'hono';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findUserById } from './user-db.util';
import { checkTownCreationEligibility } from './town-creation.util';
import { handleCreateTown } from '../handlers/towns.handler';
import { handleCreateOrgTown } from '../handlers/org-towns.handler';
import { gastownRouter } from '../trpc/router';
import type { GastownEnv } from '../gastown.worker';
import type { TRPCContext } from '../trpc/init';

const storage = vi.hoisted(() => {
  const towns: Record<string, string>[] = [];
  return {
    towns,
    createTown: async (input: Record<string, string>) => {
      const town = {
        ...input,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      towns.push(town);
      return town;
    },
  };
});

vi.mock('./user-db.util', () => ({ findUserById: vi.fn() }));
vi.mock('../dos/GastownUser.do', () => ({
  getGastownUserStub: () => ({ createTown: storage.createTown }),
}));
vi.mock('../dos/GastownOrg.do', () => ({
  getGastownOrgStub: () => ({ createTown: storage.createTown }),
}));
vi.mock('../dos/Town.do', () => ({
  getTownDOStub: () => ({
    async setTownId() {},
    async updateTownConfig() {},
  }),
}));
vi.mock('../dos/TownContainer.do', () => ({ getTownContainerStub: vi.fn() }));

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const userId = 'oauth/town-creator';
const orgId = '11111111-2222-4333-8444-555555555555';
const testEnv = {
  HYPERDRIVE: { connectionString: 'postgres://unused@localhost/unused' },
  NEXTAUTH_SECRET: 'local-test-nextauth-secret-at-least-32-characters',
} as unknown as Env;

function account(createdAt: string) {
  return { id: userId, created_at: createdAt, api_token_pepper: null, is_admin: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  storage.towns.length = 0;
  vi.mocked(findUserById).mockResolvedValue(account(new Date(NOW - WEEK_MS).toISOString()));
});

afterEach(() => vi.restoreAllMocks());

describe('Town creation account age', () => {
  it.each([0, WEEK_MS - 1, -1])('rejects an account with age %i milliseconds', async age => {
    vi.mocked(findUserById).mockResolvedValue(account(new Date(NOW - age).toISOString()));
    expect(await checkTownCreationEligibility(testEnv, userId)).toMatchObject({
      allowed: false,
      code: 'FORBIDDEN',
    });
  });

  it.each([WEEK_MS, WEEK_MS + 1])('allows an account with age %i milliseconds', async age => {
    vi.mocked(findUserById).mockResolvedValue(account(new Date(NOW - age).toISOString()));
    expect(await checkTownCreationEligibility(testEnv, userId)).toEqual({ allowed: true });
  });

  it('accepts PostgreSQL timestamp text at the seven-day boundary', async () => {
    vi.mocked(findUserById).mockResolvedValue(account('2026-10-12 12:00:00.000+00'));
    expect(await checkTownCreationEligibility(testEnv, userId)).toEqual({ allowed: true });
    expect(findUserById).toHaveBeenCalledWith(testEnv.HYPERDRIVE.connectionString, userId);
  });

  it('rejects a missing account', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    expect(await checkTownCreationEligibility(testEnv, userId)).toMatchObject({
      allowed: false,
      code: 'FORBIDDEN',
    });
  });

  it('returns a retryable failure for an invalid stored timestamp', async () => {
    vi.mocked(findUserById).mockResolvedValue(account('invalid'));
    expect(await checkTownCreationEligibility(testEnv, userId)).toMatchObject({
      allowed: false,
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

describe.each(['personal REST', 'organization REST', 'personal tRPC', 'organization tRPC'])(
  '%s town creation',
  entryPoint => {
    async function createTown(claims: { isAdmin?: boolean } = {}): Promise<number> {
      if (entryPoint.endsWith('REST')) {
        const app = new Hono<GastownEnv>();
        app.use('*', async (c, next) => {
          c.set('kiloUserId', userId);
          c.set('kiloIsAdmin', claims.isAdmin ?? false);
          return next();
        });
        app.post('/personal', c => handleCreateTown(c, { userId }));
        app.post('/organization', c => handleCreateOrgTown(c, { orgId }));
        const path = entryPoint.startsWith('personal') ? '/personal' : '/organization';
        const response = await app.request(
          `http://localhost${path}`,
          { method: 'POST', body: JSON.stringify({ name: 'New town', created_at: '2000-01-01' }) },
          testEnv
        );
        return response.status;
      }

      const ctx: TRPCContext = {
        env: testEnv,
        executionCtx: { waitUntil: vi.fn() } as unknown as ExecutionContext,
        userId,
        isAdmin: claims.isAdmin ?? false,
        apiTokenPepper: null,
        gastownAccess: true,
        orgMemberships: [{ orgId, role: 'owner' }],
      };
      const caller = gastownRouter.createCaller(ctx);
      try {
        if (entryPoint.startsWith('personal')) {
          await caller.createTown({ name: 'New town' });
        } else {
          await caller.createOrgTown({ organizationId: orgId, name: 'New town' });
        }
        return 201;
      } catch (error) {
        if (!(error instanceof TRPCError)) throw error;
        return getHTTPStatusCodeFromError(error);
      }
    }

    it('rejects a newer account before storing a town', async () => {
      vi.mocked(findUserById).mockResolvedValue(account(new Date(NOW - WEEK_MS + 1).toISOString()));
      expect(await createTown()).toBe(403);
      expect(storage.towns).toEqual([]);
    });

    it('allows creation once the account is seven days old', async () => {
      expect(await createTown()).toBe(201);
      expect(storage.towns).toEqual([expect.objectContaining({ name: 'New town' })]);
    });

    it('does not exempt a newer admin account', async () => {
      vi.mocked(findUserById).mockResolvedValue(account(new Date(NOW).toISOString()));
      expect(await createTown({ isAdmin: true })).toBe(403);
      expect(storage.towns).toEqual([]);
    });

    it('returns a retryable denial when the database fails', async () => {
      vi.mocked(findUserById).mockRejectedValue(new Error('Database unavailable'));
      expect(await createTown()).toBe(503);
      expect(storage.towns).toEqual([]);
    });
  }
);
