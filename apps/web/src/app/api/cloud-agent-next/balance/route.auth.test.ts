import jwt from 'jsonwebtoken';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';
import { GET } from './route';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';
import type { User } from '@kilocode/db/schema';
import { GET as getGenericBalance } from '@/app/api/profile/balance/route';

// Keep getUserFromAuth and validateAuthorizationHeader real; substitute only
// persistence, request context, and unrelated sign-in integrations.
const mockHeaders = jest.fn();
const mockFindUser = jest.fn();
const mockMembership = jest.fn();
const mockBalance = jest.fn();
jest.mock('next/headers', () => ({ headers: () => mockHeaders(), cookies: jest.fn() }));
jest.mock('next-auth', () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock('@/lib/user', () => ({ findUserById: (...args: unknown[]) => mockFindUser(...args) }));
jest.mock('@/lib/drizzle', () => ({
  db: { query: { kilocode_users: { findFirst: (...args: unknown[]) => mockFindUser(...args) } } },
  readDb: {},
}));
jest.mock('@/lib/organizations/organizations', () => ({
  isOrganizationMember: (...args: unknown[]) => mockMembership(...args),
}));
jest.mock('@/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: (...args: unknown[]) => mockBalance(...args),
}));
jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'balance-test-secret',
  BLACKLIST_TLDS: [],
  isResourceTokenIssuanceEnabled: () => true,
}));
jest.mock('@/lib/constants', () => ({ ORGANIZATION_ID_HEADER: 'X-KiloCode-OrganizationId' }));
jest.mock('@/lib/dotenvx', () => ({ getEnvVariable: jest.fn() }));
jest.mock('@/lib/blacklist-domains-config', () => ({ getBlacklistedDomains: async () => [] }));
jest.mock('@/lib/utils.server', () => ({
  warnExceptInTest: jest.fn(),
  sentryLogger: () => jest.fn(),
}));
jest.mock('@/lib/posthog', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/auth/magic-link-tokens', () => ({}));
jest.mock('@/lib/impact/debug', () => ({}));
jest.mock('@/lib/impact/referral', () => ({}));
jest.mock('@/lib/organizations/trial-utils', () => ({}));
jest.mock('@/lib/organizations/organization-seats', () => ({}));
jest.mock('@/lib/organizations/sales-demo', () => ({}));
jest.mock('@/lib/organizations/organization-sso-policy', () => ({}));
jest.mock('@/lib/organizations/verified-domain-membership', () => ({}));
jest.mock('@/lib/organizations/verified-domain-destination', () => ({}));
jest.mock('@/lib/account-linking-session', () => ({}));
jest.mock('@/lib/admin/admin-access-log', () => ({}));
jest.mock('@/lib/user/sso', () => ({}));
jest.mock('@/lib/web-session-revocation', () => ({}));

const organizationId = '11111111-1111-4111-8111-111111111111';
const user = {
  id: 'user_123',
  api_token_pepper: 'current-pepper',
  google_user_email: 'test@example.com',
};

function controlToken(overrides: Record<string, unknown> = {}, secret = 'balance-test-secret') {
  const now = Math.floor(Date.now() / 1000);
  // The same builder and claims used by createModernControlToken.
  const payload = buildModernKiloTokenPayload({
    userId: user.id,
    pepper: user.api_token_pepper,
    env: process.env.NODE_ENV,
    audience: 'cloud-agent-next',
    issuedAt: now,
    expiresAt: now + 60,
    tokenPurpose: 'human-api',
    credentialExchange: false,
    extra: {
      organizationId,
      tokenSource: 'cloud-agent',
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
    },
  });
  return jwt.sign({ ...payload, ...overrides }, secret, { algorithm: 'HS256' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUser.mockResolvedValue(user);
  mockMembership.mockResolvedValue(true);
  mockBalance.mockResolvedValue({ balance: 12 });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function requestWith(token: string) {
  mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));
}

it.each(['human-api', 'device-access'])(
  'accepts issuer-shaped %s control only at the dedicated endpoint',
  async tokenPurpose => {
    requestWith(
      controlToken({
        tokenPurpose,
        ...(tokenPurpose === 'device-access' ? { deviceSessionId: 'device_123' } : {}),
      })
    );
    expect((await GET()).status).toBe(200);
    expect(mockMembership).toHaveBeenCalledWith(organizationId, user.id, expect.anything());
    expect(mockBalance).toHaveBeenCalledWith(organizationId, user);
    mockBalance.mockClear();
    expect((await getGenericBalance()).status).toBe(401);
    expect(mockBalance).not.toHaveBeenCalled();
  }
);

it.each([
  { name: 'wrong audience', overrides: { aud: 'kilo-api' }, secret: 'balance-test-secret' },
  { name: 'wrong signature', overrides: {}, secret: 'wrong-secret' },
  {
    name: 'wrong pepper',
    overrides: { apiTokenPepper: 'stale-pepper' },
    secret: 'balance-test-secret',
  },
  { name: 'expired', overrides: { exp: 1 }, secret: 'balance-test-secret' },
])('rejects $name before balance access', async ({ overrides, secret }) => {
  requestWith(controlToken(overrides, secret));
  expect((await GET()).status).toBe(401);
  expect(mockBalance).not.toHaveBeenCalled();
});

it('rejects an organization the user cannot access', async () => {
  mockMembership.mockResolvedValue(false);
  requestWith(controlToken());
  expect((await GET()).status).toBe(403);
  expect(mockBalance).not.toHaveBeenCalled();
});

it('rejects malformed bearer input', async () => {
  requestWith('not-a-jwt');
  expect((await GET()).status).toBe(401);
  expect(mockBalance).not.toHaveBeenCalled();
});

it('accepts the actual control issuer output with its environment and pepper claims', async () => {
  const now = Math.floor(Date.now() / 1000);
  const principal = jwt.sign(
    buildModernKiloTokenPayload({
      userId: user.id,
      pepper: user.api_token_pepper,
      env: process.env.NODE_ENV,
      audience: 'kilo-api',
      issuedAt: now,
      expiresAt: now + 60,
      tokenPurpose: 'human-api',
      credentialExchange: true,
    }),
    'balance-test-secret',
    { algorithm: 'HS256' }
  );
  const issued = await createControlTokenForRequest(user as User, 'cloud-agent-next', {
    headers: new Headers({ Authorization: `Bearer ${principal}` }),
    tokenSource: 'cloud-agent',
  });
  expect(jwt.verify(issued.token, 'balance-test-secret')).toMatchObject({
    aud: 'cloud-agent-next',
    env: process.env.NODE_ENV,
    apiTokenPepper: user.api_token_pepper,
    credentialExchange: false,
  });
  requestWith(issued.token);
  expect((await GET()).status).toBe(200);
  expect((await getGenericBalance()).status).toBe(401);
});
