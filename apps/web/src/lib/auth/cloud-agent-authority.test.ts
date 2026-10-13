import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { User } from '@kilocode/db/schema';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import { validateAuthorizationHeader } from '@kilocode/web-shared/lib/tokens';
import {
  getUserFromAuth,
  getUserFromBearerForCredentialExchange,
} from '@kilocode/web-shared/lib/user/server';
import {
  baseProcedure,
  createTRPCContext,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import {
  createControlTokenForRequest,
  createDelegatedResourceToken,
  getResourceDelegationAuthority,
} from './resource-delegation';
import { GET as getIdentity } from '@/app/api/user/route';
import { POST as mintGastownToken } from '@/app/api/gastown/token/route';
import { POST as mintWastelandToken } from '@/app/api/wasteland/token/route';
import {
  personalPrepareSessionNextSchema,
  organizationPrepareSessionNextSchema,
} from '@/routers/cloud-agent-next-schemas';

const secret = 'fixture-only-web-cloud-agent-secret';
const mockHeaders = jest.fn();
const mockFindUser = jest.fn();
const mockMembership = jest.fn();
const mockDirectMembership = jest.fn();
const mockGetServerSession = jest.fn();
const mockResolver = jest.fn();
const mockOrgMemberships = jest.fn();
const mockGastownEnabled = jest.fn();
let resourceMigrationEnabled = true;

jest.mock('next/headers', () => ({ headers: () => mockHeaders(), cookies: jest.fn() }));
jest.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'fixture-only-web-cloud-agent-secret',
  isResourceTokenIssuanceEnabled: () => resourceMigrationEnabled,
}));
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({ getEnvVariable: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: (...args: unknown[]) => mockFindUser(...args),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    query: { kilocode_users: { findFirst: (...args: unknown[]) => mockFindUser(...args) } },
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: () => mockDirectMembership() }) }),
      }),
    }),
  },
  readDb: {},
}));
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  isOrganizationMember: (...args: unknown[]) => mockMembership(...args),
  getUserOrgMemberships: (...args: unknown[]) => mockOrgMemberships(...args),
}));
jest.mock('@/lib/gastown/feature-flags', () => ({
  isGastownEnabled: (...args: unknown[]) => mockGastownEnabled(...args),
}));
jest.mock('@/lib/organizations/organization-auth', () => ({ getAuthorizedOrgContext: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/constants', () => ({
  ORGANIZATION_ID_HEADER: 'X-KiloCode-OrganizationId',
}));
jest.mock('@kilocode/web-shared/lib/blacklist-domains-config', () => ({
  getBlacklistedDomains: async () => [],
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  warnExceptInTest: jest.fn(),
  logExceptInTest: jest.fn(),
  sentryLogger: () => jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/admin/admin-access-log', () => ({
  authViaTokenFromHeaders: (headers: Headers) => headers.has('authorization'),
  clientIpFromHeaders: () => null,
  routeFromHeaders: () => null,
  emitAdminAccessEvent: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/web-session-revocation', () => ({
  isWebSessionCurrent: () => true,
}));
jest.mock('@sentry/nextjs', () => ({
  setTag: jest.fn(),
  trpcMiddleware:
    () =>
    ({ next }: { next: () => unknown }) =>
      next(),
}));
jest.mock('@kilocode/web-shared/lib/trpc/min-version', () => ({ isMobileClient: () => false }));
jest.mock('@kilocode/web-shared/lib/trpc/control-plane-budget', () => ({
  withControlPlaneBudget: ({ next }: { next: () => unknown }) => next(),
  controlPlanePathFromInfo: () => 'fixture',
  controlPlaneTypeFromInfo: () => 'mutation',
}));

const now = Math.floor(Date.now() / 1000);
const organizationId = '11111111-1111-4111-8111-111111111111';
const user = {
  id: 'oauth/fixture-user',
  api_token_pepper: null,
  google_user_email: 'fixture@example.com',
  blocked_at: null,
  blocked_reason: null,
  is_admin: false,
} as User;
const scope: CloudAgentAuthority = {
  version: 1,
  ownerId: user.id,
  parentSessionId: 'workspace_fixture-parent',
  organizationId: null,
  procedures: ['cloudAgentNext.prepareSession'],
  repositories: ['acme/repo'],
  models: ['provider/model'],
  remainingDepth: 1,
  expiresAt: now + 900,
};
const launch = {
  githubRepo: 'acme/repo',
  model: 'provider/model',
  mode: 'code',
  prompt: 'Launch the child',
  autoInitiate: true,
  parentCloudAgentSessionId: scope.parentSessionId,
};
function scopedClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    kiloUserId: user.id,
    apiTokenPepper: user.api_token_pepper,
    env: process.env.NODE_ENV,
    aud: 'kilo-api',
    iat: now,
    exp: scope.expiresAt,
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    cloudAgentAuthority: scope,
    ...overrides,
  };
}
function bearer(claims: Record<string, unknown> = scopedClaims(), signingSecret = secret) {
  return new Headers({
    authorization: `Bearer ${jwt.sign(claims, signingSecret, { algorithm: 'HS256' })}`,
  });
}
const router = createTRPCRouter({
  cloudAgentNext: createTRPCRouter({
    prepareSession: baseProcedure
      .input(personalPrepareSessionNextSchema)
      .mutation(({ input }) => mockResolver(input)),
    sendMessage: baseProcedure
      .input(z.object({ prompt: z.string() }))
      .mutation(() => mockResolver()),
  }),
  organizations: createTRPCRouter({
    cloudAgentNext: createTRPCRouter({
      prepareSession: baseProcedure
        .input(organizationPrepareSessionNextSchema)
        .mutation(({ input }) => mockResolver(input)),
    }),
  }),
  user: createTRPCRouter({ getMe: baseProcedure.query(() => mockResolver()) }),
});
function context(authority: CloudAgentAuthority | undefined = scope): TRPCContext {
  return { user, cloudAgentAuthority: authority };
}

beforeEach(() => {
  jest.clearAllMocks();
  resourceMigrationEnabled = true;
  mockHeaders.mockResolvedValue(bearer());
  mockFindUser.mockResolvedValue(user);
  mockMembership.mockResolvedValue(true);
  mockDirectMembership.mockResolvedValue([{ id: 'fixture-membership' }]);
  mockGetServerSession.mockResolvedValue({ kiloUserId: user.id });
  mockOrgMemberships.mockResolvedValue([]);
  mockGastownEnabled.mockResolvedValue(true);
  mockResolver.mockResolvedValue('launched');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('verified scoped web authentication', () => {
  it('projects only identity and verified scope through /api/user', async () => {
    const response = await getIdentity();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: user.id, cloudAgentAuthority: scope });
    const auth = await getUserFromAuth({ adminOnly: false, requestPathname: '/api/user' });
    expect(auth.cloudAgentAuthority).toEqual(scope);
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    '/api/gastown/token',
    '/api/wasteland/token',
    '/api/profile',
    '/api/trpc/user.getMe',
    '/api/trpc/cloudAgentNext.prepareSession,user.getMe',
  ])('denies direct REST and unrelated procedure paths %s', async requestPathname => {
    const headers = bearer();
    headers.set('x-pathname', '/api/user');
    mockHeaders.mockResolvedValue(headers);
    const auth = await getUserFromAuth({ adminOnly: false, requestPathname });
    expect(auth.user).toBeNull();
    expect(auth.credentialsRejected).toBe(true);
    expect(mockFindUser).not.toHaveBeenCalled();
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });
  it.each([
    { aud: 'cloud-agent-next' },
    { exp: 1 },
    { kiloUserId: 'forged-owner' },
    { iat: now + 10 },
    { apiTokenPepper: 'stale' },
    { runtimeAdmission: {} },
    { futureRestriction: false },
    { tokenPurpose: 'human-api' },
    { organizationId },
  ])('denies malformed/widened scope without session downgrade %j', async overrides => {
    mockHeaders.mockResolvedValue(bearer(scopedClaims(overrides)));
    const auth = await getUserFromAuth({ adminOnly: false, requestPathname: '/api/user' });
    expect(auth.user).toBeNull();
    expect(auth.credentialsRejected).toBe(true);
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });
  it('denies forged signature, admin access and conflicting personal org headers', async () => {
    mockHeaders.mockResolvedValue(bearer(scopedClaims(), 'forged-secret'));
    expect((await getIdentity()).status).toBe(401);
    mockHeaders.mockResolvedValue(bearer());
    expect(
      (await getUserFromAuth({ adminOnly: true, requestPathname: '/api/user' })).user
    ).toBeNull();
    const headers = bearer();
    headers.set('X-KiloCode-OrganizationId', organizationId);
    mockHeaders.mockResolvedValue(headers);
    expect((await getIdentity()).status).toBe(403);
  });
  it('cannot reach direct REST credential mint paths even with a valid browser cookie', async () => {
    const headers = bearer();
    headers.set('cookie', 'next-auth.session-token=fixture');
    headers.set('x-pathname', '/api/user');
    mockHeaders.mockResolvedValue(headers);
    expect((await mintGastownToken()).status).toBe(401);
    expect((await mintWastelandToken()).status).toBe(401);
    expect(mockOrgMemberships).not.toHaveBeenCalled();
    expect(mockGastownEnabled).not.toHaveBeenCalled();
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });
  it('rechecks scope expiry after awaiting current-user authorization', async () => {
    mockFindUser.mockImplementation(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(scope.expiresAt * 1000);
      return user;
    });
    expect((await getIdentity()).status).toBe(401);
  });
  it('checks current scoped org membership and preserves signed org metadata', async () => {
    const orgScope = {
      ...scope,
      organizationId,
      procedures: ['organizations.cloudAgentNext.prepareSession'] as const,
    };
    mockHeaders.mockResolvedValue(
      bearer(scopedClaims({ organizationId, cloudAgentAuthority: orgScope }))
    );
    expect(
      (await getUserFromAuth({ adminOnly: false, requestPathname: '/api/user' })).organizationId
    ).toBe(organizationId);
    mockMembership.mockResolvedValue(false);
    expect((await getIdentity()).status).toBe(403);
  });
  it('retains ordinary bearer and browser-session behavior without trusted pathname', async () => {
    const claims = scopedClaims();
    delete claims.cloudAgentAuthority;
    mockHeaders.mockResolvedValue(
      bearer({ ...claims, tokenPurpose: 'human-api', credentialExchange: true })
    );
    expect((await getUserFromAuth({ adminOnly: false })).user?.id).toBe(user.id);
    expect(await (await getIdentity()).json()).toEqual(user);
    mockHeaders.mockResolvedValue(new Headers());
    expect((await getUserFromAuth({ adminOnly: false })).user?.id).toBe(user.id);
    expect(mockGetServerSession).toHaveBeenCalled();
  });
  it('rejects scoped general credential exchange and missing trusted path in lower-level validation', async () => {
    expect(
      (await getUserFromBearerForCredentialExchange(bearer(), { legacy: 'five-year-api' })).user
    ).toBeNull();
    const headers = bearer();
    headers.set('x-pathname', '/api/user');
    expect(validateAuthorizationHeader(headers).reason).toBe('cloud_agent_authority_denied');
  });
});

describe('raw tRPC scope enforcement', () => {
  it('uses actual request URL/headers and preserves authority in context', async () => {
    const req = new Request('https://fixture.invalid/api/trpc/cloudAgentNext.prepareSession', {
      headers: bearer(),
    });
    const ctx = await createTRPCContext({ req });
    expect(ctx.cloudAgentAuthority).toEqual(scope);
    expect(await router.createCaller(ctx).cloudAgentNext.prepareSession(launch)).toBe('launched');
    const forbidden = new Request('https://fixture.invalid/api/trpc/user.getMe', {
      headers: bearer(),
    });
    await expect(createTRPCContext({ req: forbidden })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  it('does not use spoofed x-pathname when no actual request URL exists', async () => {
    const headers = bearer();
    headers.set('x-pathname', '/api/trpc/cloudAgentNext.prepareSession');
    mockHeaders.mockResolvedValue(headers);
    await expect(createTRPCContext()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it.each([
    { profileId: organizationId },
    { envVars: {} },
    { mcpServers: {} },
    { setupCommands: [] },
    { cloudAgentSpawn: {} },
    { images: {} },
    { attachments: {} },
    { gitUrl: 'https://fixture.invalid' },
    { initialPayload: {} },
    { futureEscapeField: true },
    { parentCloudAgentSessionId: 'workspace_sibling' },
    { githubRepo: 'acme/other' },
    { model: 'provider/other' },
    { organizationId },
    { autoInitiate: false },
  ])('rejects raw widening before schema strips unknown fields %j', async overrides => {
    const input = { ...launch, ...overrides } as z.input<typeof personalPrepareSessionNextSchema>;
    await expect(
      router.createCaller(context()).cloudAgentNext.prepareSession(input)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockResolver).not.toHaveBeenCalled();
  });
  it('denies unrelated procedures, expired scope and user mismatch', async () => {
    const caller = router.createCaller(context());
    await expect(caller.user.getMe()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.cloudAgentNext.sendMessage({ prompt: 'escape' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      router.createCaller(context({ ...scope, expiresAt: 1 })).cloudAgentNext.prepareSession(launch)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      router
        .createCaller({ ...context(), user: { ...user, id: 'other-user' } })
        .cloudAgentNext.prepareSession(launch)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('allows only the matching org procedure/input and does not change ordinary callers', async () => {
    const orgScope: CloudAgentAuthority = {
      ...scope,
      organizationId,
      procedures: ['organizations.cloudAgentNext.prepareSession'],
    };
    const caller = router.createCaller(context(orgScope));
    expect(
      await caller.organizations.cloudAgentNext.prepareSession({ ...launch, organizationId })
    ).toBe('launched');
    await expect(
      caller.organizations.cloudAgentNext.prepareSession({
        ...launch,
        organizationId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await router
        .createCaller({ user })
        .cloudAgentNext.prepareSession({ ...launch, autoInitiate: false })
    ).toBe('launched');
  });
});

describe('scope-preserving control token exchange', () => {
  it('mints only cloud-agent control with identical scope and parent expiration, even with migration disabled', async () => {
    resourceMigrationEnabled = false;
    const result = await createControlTokenForRequest(user, 'cloud-agent-next', {
      headers: bearer(),
      expiresIn: 100_000,
      extra: { isAdmin: true },
    });
    const claims = jwt.verify(result.token, secret) as jwt.JwtPayload;
    expect(claims).toMatchObject({
      aud: 'cloud-agent-next',
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      exp: scope.expiresAt,
      cloudAgentAuthority: scope,
    });
    expect(claims.runtimeAdmission).toBeUndefined();
    expect(claims.runtimeAuthorization).toBeUndefined();
    expect(claims.isAdmin).toBeUndefined();
    expect(result.expiresAt).toBe(new Date(scope.expiresAt * 1000).toISOString());
  });
  it.each(['gastown', 'wasteland'] as const)('cannot mint %s control', async resource => {
    await expect(
      createControlTokenForRequest(user, resource, { headers: bearer() })
    ).rejects.toMatchObject({ status: 403 });
  });
  it('cannot mint other delegations, change org, re-exchange control, or use stale principal', async () => {
    await expect(getResourceDelegationAuthority(user, { headers: bearer() })).rejects.toMatchObject(
      { status: 403 }
    );
    await expect(
      createDelegatedResourceToken(user, 'gateway', { headers: bearer() })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createControlTokenForRequest(user, 'cloud-agent-next', { headers: bearer(), organizationId })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createControlTokenForRequest(user, 'cloud-agent-next', {
        headers: bearer(scopedClaims({ aud: 'cloud-agent-next' })),
      })
    ).rejects.toMatchObject({ status: 401 });
    mockFindUser.mockResolvedValue({ ...user, api_token_pepper: 'rotated' });
    await expect(
      createControlTokenForRequest(user, 'cloud-agent-next', { headers: bearer() })
    ).rejects.toMatchObject({ status: 401 });
  });
  it('requires current direct org membership and preserves signed org exactly', async () => {
    const orgScope = {
      ...scope,
      organizationId,
      procedures: ['organizations.cloudAgentNext.prepareSession'],
    };
    const headers = bearer(scopedClaims({ organizationId, cloudAgentAuthority: orgScope }));
    const issued = await createControlTokenForRequest(user, 'cloud-agent-next', {
      headers,
      organizationId,
    });
    expect(jwt.verify(issued.token, secret)).toMatchObject({
      organizationId,
      cloudAgentAuthority: orgScope,
    });
    mockDirectMembership.mockResolvedValue([]);
    await expect(
      createControlTokenForRequest(user, 'cloud-agent-next', { headers, organizationId })
    ).rejects.toMatchObject({ status: 401 });
  });
  it('keeps ordinary human control exchange and rejects non-spawn delegated credentials', async () => {
    const claims = scopedClaims();
    delete claims.cloudAgentAuthority;
    const human = bearer({ ...claims, tokenPurpose: 'human-api', credentialExchange: true });
    const issued = await createControlTokenForRequest(user, 'cloud-agent-next', { headers: human });
    expect(jwt.verify(issued.token, secret)).toMatchObject({
      tokenPurpose: 'human-api',
      runtimeAdmission: { source: 'user' },
    });
    await expect(
      createControlTokenForRequest(user, 'cloud-agent-next', { headers: bearer(claims) })
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('ordinary opt-in schema', () => {
  it('preserves policy and parent fields through prepare parsing and rejects widening policy', () => {
    const policy = {
      procedures: scope.procedures,
      repositories: scope.repositories,
      models: scope.models,
      remainingDepth: 1,
    };
    expect(
      personalPrepareSessionNextSchema.parse({ ...launch, cloudAgentSpawn: policy })
    ).toMatchObject({ cloudAgentSpawn: policy, parentCloudAgentSessionId: scope.parentSessionId });
    expect(
      personalPrepareSessionNextSchema.safeParse({
        ...launch,
        cloudAgentSpawn: { ...policy, extra: true },
      }).success
    ).toBe(false);
  });
});
