import { Hono } from 'hono';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gastownAccessMiddleware } from '../middleware/gastown-access.middleware';
import { handleCreateTown } from './towns.handler';
import { handleCreateOrgTown } from './org-towns.handler';
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

const userId = 'oauth/town-creator';
const orgId = '11111111-2222-4333-8444-555555555555';
const testEnv = {
  NEXTAUTH_SECRET: 'local-test-nextauth-secret-at-least-32-characters',
} as unknown as Env;

type Claims = {
  gastownAccess: boolean;
  isAdmin?: boolean;
};

function restApp(claims: Claims) {
  const app = new Hono<GastownEnv>();
  app.use('*', async (c, next) => {
    c.set('kiloUserId', userId);
    c.set('kiloIsAdmin', claims.isAdmin ?? false);
    c.set('kiloGastownAccess', claims.gastownAccess);
    c.set('kiloOrgMemberships', [{ orgId, role: 'owner' }]);
    return next();
  });
  app.post('/personal', gastownAccessMiddleware, c => handleCreateTown(c, { userId }));
  app.post('/organization', gastownAccessMiddleware, c => handleCreateOrgTown(c, { orgId }));
  return app;
}

function trpcContext(claims: Claims): TRPCContext {
  return {
    env: testEnv,
    executionCtx: { waitUntil: vi.fn() } as unknown as ExecutionContext,
    userId,
    isAdmin: claims.isAdmin ?? false,
    apiTokenPepper: null,
    gastownAccess: claims.gastownAccess,
    orgMemberships: [{ orgId, role: 'owner' }],
  };
}

async function createTown(
  entryPoint: 'personal REST' | 'organization REST' | 'personal tRPC' | 'organization tRPC',
  claims: Claims
): Promise<number> {
  if (entryPoint.endsWith('REST')) {
    const app = restApp(claims);
    const path = entryPoint.startsWith('personal') ? '/personal' : '/organization';
    const response = await app.request(
      `http://localhost${path}`,
      { method: 'POST', body: JSON.stringify({ name: 'New town' }) },
      testEnv
    );
    return response.status;
  }

  const caller = gastownRouter.createCaller(trpcContext(claims));
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

beforeEach(() => {
  vi.clearAllMocks();
  storage.towns.length = 0;
});

describe.each([
  'personal REST',
  'organization REST',
  'personal tRPC',
  'organization tRPC',
] as const)('%s town creation', entryPoint => {
  it('rejects creation without Gastown access', async () => {
    expect(await createTown(entryPoint, { gastownAccess: false })).toBe(403);
    expect(storage.towns).toEqual([]);
  });

  it('does not exempt admins without Gastown access', async () => {
    expect(await createTown(entryPoint, { gastownAccess: false, isAdmin: true })).toBe(403);
    expect(storage.towns).toEqual([]);
  });

  it('allows creation with Gastown access', async () => {
    expect(await createTown(entryPoint, { gastownAccess: true })).toBe(201);
    expect(storage.towns).toEqual([expect.objectContaining({ name: 'New town' })]);
  });
});
