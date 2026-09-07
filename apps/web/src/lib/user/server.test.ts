const mockHeaders = jest.fn<Promise<Headers>, []>();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

const mockGetServerSession = jest.fn();
const mockRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  redirect: (url: string) => mockRedirect(url),
}));

import { afterEach, beforeAll, beforeEach, describe, test, expect } from '@jest/globals';
import {
  isEmailBlacklistedByDomain,
  isBlockedTLD,
  parseLinkedInProfileName,
  parseAnacondaProfile,
  profileProvesEmailOwnership,
  authOptions,
  getUserUUID,
  uuidSchema,
  parseSignInRedirectContext,
  getProfileRedirectPath,
  getUserFromAuth,
  getUserFromBearerForCredentialExchange,
  getUserFromSessionForCredentialIssuance,
  getUserFromSessionForCredentialIssuanceOrRedirect,
} from './server';
import { db } from '@/lib/drizzle';
import { setAdminAccessSinkForTest, type AdminAccessEvent } from '@/lib/admin/admin-access-log';
import {
  kilocode_users,
  organization_domain_claims,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import type { Organization, User } from '@kilocode/db/schema';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { generateApiToken, JWT_TOKEN_VERSION } from '@/lib/tokens';
import { eq } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import jwt from 'jsonwebtoken';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { signKiloToken } from '@kilocode/worker-utils/kilo-token';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

// Same namespace UUID used in user.server.ts
const USER_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

beforeEach(() => {
  mockHeaders.mockReset();
  mockGetServerSession.mockReset();
  mockRedirect.mockClear();
});

function signPolicyClaims(claims: Record<string, unknown>, secret = NEXTAUTH_SECRET): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256' });
}

describe('isEmailBlacklistedByDomain', () => {
  test('should return false when blacklisted_domains is undefined', () => {
    const result = isEmailBlacklistedByDomain('test@example.com', undefined);
    expect(result).toBe(false);
  });

  test('should return false when blacklisted_domains is empty array', () => {
    const result = isEmailBlacklistedByDomain('test@example.com', []);
    expect(result).toBe(false);
  });

  test('should return false when email domain is not in blacklist', () => {
    const blacklist = ['spam.com', 'malicious.org'];
    const result = isEmailBlacklistedByDomain('user@legitimate.com', blacklist);
    expect(result).toBe(false);
  });

  test('should return true when email domain matches blacklisted domain with @', () => {
    const blacklist = ['spam.com', 'malicious.org'];
    const result = isEmailBlacklistedByDomain('user@spam.com', blacklist);
    expect(result).toBe(true);
  });

  test('should return true for subdomain with @ pattern', () => {
    const blacklist = ['example.com'];
    const result = isEmailBlacklistedByDomain('user@sub.example.com', blacklist);
    expect(result).toBe(true);
  });

  test('should handle multiple domains in blacklist', () => {
    const blacklist = ['spam.com', 'malicious.org', 'bad.net'];

    expect(isEmailBlacklistedByDomain('user@spam.com', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@malicious.org', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@bad.net', blacklist)).toBe(true);

    expect(isEmailBlacklistedByDomain('user@good.com', blacklist)).toBe(false);
  });

  test('should be case insensitive', () => {
    const blacklist = ['spam.com'];
    const result = isEmailBlacklistedByDomain('user@SPAM.COM', blacklist);
    expect(result).toBe(true); // Case insensitive, so should match
  });

  test('should handle edge case with domain as part of username', () => {
    const blacklist = ['spam.com'];
    const result = isEmailBlacklistedByDomain('spam.com@legitimate.org', blacklist);
    expect(result).toBe(false);
  });

  test('should match exact domain endings correctly', () => {
    const blacklist = ['evil.com'];

    // Should match
    expect(isEmailBlacklistedByDomain('user@evil.com', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('something.evil.com', blacklist)).toBe(true);

    // Should NOT match
    expect(isEmailBlacklistedByDomain('user@notevil.com', blacklist)).toBe(false);
    expect(isEmailBlacklistedByDomain('user@evil.com.fake', blacklist)).toBe(false);
  });

  test('should handle mixed case in both email and blacklist', () => {
    const blacklist = ['EXAMPLE.COM', 'Test-Domain.ORG'];
    expect(isEmailBlacklistedByDomain('user@example.com', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('USER@EXAMPLE.COM', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@test-domain.org', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('USER@TEST-DOMAIN.ORG', blacklist)).toBe(true);
  });

  test('should handle case insensitive subdomain matching', () => {
    const blacklist = ['EXAMPLE.COM'];
    expect(isEmailBlacklistedByDomain('user.sub.example.com', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user.SUB.EXAMPLE.COM', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user.Sub.Example.Com', blacklist)).toBe(true);
  });
});

describe('isBlockedTLD', () => {
  const blockedTlds = ['.shop', '.top'];

  test('should block .shop TLD', () => {
    expect(isBlockedTLD('user@example.shop', blockedTlds)).toBe(true);
  });

  test('should block .top TLD', () => {
    expect(isBlockedTLD('user@example.top', blockedTlds)).toBe(true);
  });

  test('should block subdomains under blocked TLDs', () => {
    expect(isBlockedTLD('user@sub.domain.shop', blockedTlds)).toBe(true);
    expect(isBlockedTLD('user@sub.domain.top', blockedTlds)).toBe(true);
  });

  test('should allow .com, .org, .io TLDs', () => {
    expect(isBlockedTLD('user@example.com', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@example.org', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@example.io', blockedTlds)).toBe(false);
  });

  test('should be case insensitive', () => {
    expect(isBlockedTLD('user@example.SHOP', blockedTlds)).toBe(true);
    expect(isBlockedTLD('user@example.TOP', blockedTlds)).toBe(true);
    expect(isBlockedTLD('USER@EXAMPLE.Shop', blockedTlds)).toBe(true);
  });

  test('should not block domains containing blocked TLD as a non-TLD part', () => {
    expect(isBlockedTLD('user@shop.example.com', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@top.example.com', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@myshop.com', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@topnotch.com', blockedTlds)).toBe(false);
  });

  test('should return false when blocklist is empty', () => {
    expect(isBlockedTLD('user@example.shop', [])).toBe(false);
  });

  test('should handle multi-part TLDs like .co.uk', () => {
    const withMultiPart = ['.shop', '.co.uk'];
    expect(isBlockedTLD('user@example.co.uk', withMultiPart)).toBe(true);
    expect(isBlockedTLD('user@example.com', withMultiPart)).toBe(false);
    expect(isBlockedTLD('user@example.uk', withMultiPart)).toBe(false);
  });
});

/**
 * This test verifies the LinkedIn profile name parsing logic
 * to prevent the production error: TypeError: e.default[b] is not a function
 * https://kilo-code.sentry.io/issues/7080760666
 */
describe('parseLinkedInProfileName', () => {
  test('should use profile.name when available', () => {
    const result = parseLinkedInProfileName({ name: 'John Doe' });
    expect(result).toBe('John Doe');
    expect(typeof result).toBe('string');
  });

  test('should combine given_name and family_name when both present', () => {
    const result = parseLinkedInProfileName({
      given_name: 'John',
      family_name: 'Doe',
    });
    expect(result).toBe('John Doe');
    expect(typeof result).toBe('string');
  });

  test('should use given_name only when family_name is missing', () => {
    const result = parseLinkedInProfileName({ given_name: 'John' });
    expect(result).toBe('John');
    expect(typeof result).toBe('string');
  });

  test('should use family_name only when given_name is missing', () => {
    const result = parseLinkedInProfileName({ family_name: 'Doe' });
    expect(result).toBe('Doe');
    expect(typeof result).toBe('string');
  });

  test('should return default when no name fields present', () => {
    const result = parseLinkedInProfileName({});
    expect(result).toBe('LinkedIn User');
    expect(typeof result).toBe('string');
  });

  test('CRITICAL: should always return a string, never a boolean', () => {
    // This was the bug - the old code could return a boolean
    const testCases = [
      { name: 'John Doe' },
      { given_name: 'John', family_name: 'Doe' },
      { given_name: 'John' },
      { family_name: 'Doe' },
      {},
    ];

    testCases.forEach(profile => {
      const result = parseLinkedInProfileName(profile);
      expect(typeof result).toBe('string');
      expect(result).not.toBe(true);
      expect(result).not.toBe(false);
    });
  });
});

describe('Anaconda OAuth provider', () => {
  test('maps a valid profile and uses sub as the stable account id', () => {
    expect(
      parseAnacondaProfile({
        sub: 'anaconda-user-123',
        iss: 'https://auth.anaconda.com/api/auth',
        aud: 'kilo-client-id',
        email: 'user@example.com',
        email_verified: true,
        given_name: 'Anaconda',
        family_name: 'User',
        picture: 'https://example.com/avatar.png',
      })
    ).toEqual({
      id: 'anaconda-user-123',
      email: 'user@example.com',
      name: 'Anaconda User',
      image: 'https://example.com/avatar.png',
    });
  });

  test('uses the email local part when the profile omits a name', () => {
    expect(
      parseAnacondaProfile({
        sub: 'anaconda-user-123',
        email: 'local-part@example.com',
        email_verified: true,
      })
    ).toMatchObject({ name: 'local-part' });
  });

  test.each([
    [{ email: 'user@example.com', email_verified: true }, 'missing subject'],
    [{ sub: 'anaconda-user-123', email_verified: true }, 'missing email'],
    [{ sub: '', email: 'user@example.com', email_verified: true }, 'empty subject'],
    [{ sub: 'anaconda-user-123', email: 'not-an-email', email_verified: true }, 'invalid email'],
  ])('rejects a profile with %s (%s)', (profile, _reason) => {
    expect(() => parseAnacondaProfile(profile)).toThrow();
  });

  test.each([
    ['missing', { sub: 'anaconda-user-123', email: 'user@example.com' }],
    ['false', { sub: 'anaconda-user-123', email: 'user@example.com', email_verified: false }],
  ])('rejects an email_verified claim that is %s', (_claimState, profile) => {
    expect(() => parseAnacondaProfile(profile)).toThrow();
  });

  test('registers discovery, ID tokens, OIDC checks, and client secret POST authentication', () => {
    expect(authOptions.providers.find(provider => provider.id === 'anaconda')).toMatchObject({
      issuer: 'https://auth.anaconda.com/api/auth',
      wellKnown: 'https://anaconda.com/.well-known/openid-configuration',
      authorization: { params: { scope: 'openid profile email' } },
      idToken: true,
      checks: ['pkce', 'state', 'nonce'],
      client: { token_endpoint_auth_method: 'client_secret_post' },
    });
  });
});

describe('profileProvesEmailOwnership', () => {
  test('accepts a boolean true email_verified claim', () => {
    expect(profileProvesEmailOwnership({ email_verified: true })).toBe(true);
  });

  test('accepts the string "true" email_verified claim (Apple)', () => {
    expect(profileProvesEmailOwnership({ email_verified: 'true' })).toBe(true);
  });

  test('rejects a boolean false email_verified claim', () => {
    expect(profileProvesEmailOwnership({ email_verified: false })).toBe(false);
  });

  test('rejects the string "false" email_verified claim', () => {
    expect(profileProvesEmailOwnership({ email_verified: 'false' })).toBe(false);
  });

  test('rejects a profile without the email_verified claim', () => {
    expect(profileProvesEmailOwnership({})).toBe(false);
  });

  test('rejects undefined', () => {
    expect(profileProvesEmailOwnership(undefined)).toBe(false);
  });
});

describe('getUserUUID', () => {
  test('should return the same UUID for a user with a valid UUID id', () => {
    const validUUID = '550e8400-e29b-41d4-a716-446655440000';
    const user = { id: validUUID } as User;

    const result = getUserUUID(user);

    expect(result).toBe(validUUID);
    expect(typeof result).toBe('string');
  });

  test('should generate a UUID for a legacy user id (oauth/google format)', () => {
    const legacyId = 'oauth/google:114000741928328149731';
    const user = { id: legacyId } as User;

    const result = getUserUUID(user);

    // Should return a valid UUID
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(typeof result).toBe('string');
  });

  test('should always return the SAME UUID for the same legacy user id', () => {
    const legacyId = 'oauth/google:114000741928328149731';
    const user = { id: legacyId } as User;

    const result1 = getUserUUID(user);
    const result2 = getUserUUID(user);
    const result3 = getUserUUID(user);

    // All calls should return the exact same UUID
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);

    // Verify it matches the expected uuidv5 output
    const expectedUUID = uuidv5(legacyId, USER_UUID_NAMESPACE);
    expect(result1).toBe(expectedUUID);
  });

  test('should generate different UUIDs for different legacy user ids', () => {
    const legacyId1 = 'oauth/google:114000741928328149731';
    const legacyId2 = 'oauth/google:987654321098765432109';

    const user1 = { id: legacyId1 } as User;
    const user2 = { id: legacyId2 } as User;

    const result1 = getUserUUID(user1);
    const result2 = getUserUUID(user2);

    expect(result1).not.toBe(result2);
    expect(result1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('should handle various legacy id formats consistently', () => {
    const legacyFormats = [
      'oauth/google:114000741928328149731',
      'oauth/github:12345678',
      'oauth/gitlab:abcdef123',
      'some-other-legacy-format',
    ];

    legacyFormats.forEach(legacyId => {
      const user = { id: legacyId } as User;
      const result = getUserUUID(user);

      // Should always return a valid UUID
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      // Should be consistent across multiple calls
      expect(getUserUUID(user)).toBe(result);

      // Should match the expected uuidv5 output
      expect(result).toBe(uuidv5(legacyId, USER_UUID_NAMESPACE));
    });
  });

  test('should handle edge case with UUID-like string that is not valid', () => {
    const invalidUUID = '550e8400-e29b-41d4-a716-44665544000'; // Missing one character
    const user = { id: invalidUUID } as User;

    const result = getUserUUID(user);

    // Should generate a new UUID since the input is not a valid UUID
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result).toBe(uuidv5(invalidUUID, USER_UUID_NAMESPACE));
  });

  test('CRITICAL: should always return a UUID string, never undefined or null', () => {
    const testCases = [
      { id: '550e8400-e29b-41d4-a716-446655440000' }, // Valid UUID
      { id: 'oauth/google:114000741928328149731' }, // Legacy format
      { id: 'some-random-string' }, // Random string
      { id: '' }, // Empty string
    ];

    testCases.forEach(user => {
      const result = getUserUUID(user as User);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  test('should be deterministic - same input always produces same output', () => {
    const testCases = [
      'oauth/google:114000741928328149731',
      'oauth/github:12345',
      'random-legacy-id',
    ];

    testCases.forEach(legacyId => {
      const user = { id: legacyId } as User;

      // Call the function multiple times
      const results = Array.from({ length: 10 }, () => getUserUUID(user));

      // All results should be identical
      const firstResult = results[0];
      results.forEach(result => {
        expect(result).toBe(firstResult);
      });
    });
  });
});

/**
 * This test verifies the UUID validation for organization IDs
 * to prevent the production error: invalid input syntax for type uuid
 * https://kilo-code.sentry.io/issues/KILOCODE-WEB-5MK
 *
 * The extension was sending organization names instead of UUIDs in the
 * X-KiloCode-OrganizationId header, causing PostgreSQL to throw an error.
 */
describe('uuidSchema (organization ID validation)', () => {
  test('should accept valid UUID v4', () => {
    const validUUID = '550e8400-e29b-41d4-a716-446655440000';
    const result = uuidSchema.safeParse(validUUID);
    expect(result.success).toBe(true);
  });

  test('should accept valid UUID with lowercase letters', () => {
    const validUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = uuidSchema.safeParse(validUUID);
    expect(result.success).toBe(true);
  });

  test('should accept valid UUID with uppercase letters', () => {
    const validUUID = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
    const result = uuidSchema.safeParse(validUUID);
    expect(result.success).toBe(true);
  });

  test('REGRESSION: should reject organization name instead of UUID', () => {
    // This was the actual bug - extension sent an organization name instead of a UUID
    const organizationName = 'MyOrganization';
    const result = uuidSchema.safeParse(organizationName);
    expect(result.success).toBe(false);
  });

  test('should reject empty string', () => {
    const result = uuidSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  test('should reject random strings', () => {
    const testCases = [
      'not-a-uuid',
      'my-organization',
      'test123',
      'some-org-name',
      'acme-corp',
      'org_12345',
    ];

    testCases.forEach(invalidValue => {
      const result = uuidSchema.safeParse(invalidValue);
      expect(result.success).toBe(false);
    });
  });

  test('should reject UUID-like strings with wrong format', () => {
    const testCases = [
      '550e8400-e29b-41d4-a716-44665544000', // Missing one character
      '550e8400e29b41d4a716446655440000', // Missing dashes
      '550e8400-e29b-41d4-a716-4466554400000', // Extra character
      'g50e8400-e29b-41d4-a716-446655440000', // Invalid character 'g'
    ];

    testCases.forEach(invalidValue => {
      const result = uuidSchema.safeParse(invalidValue);
      expect(result.success).toBe(false);
    });
  });

  test('should reject null and undefined', () => {
    expect(uuidSchema.safeParse(null).success).toBe(false);
    expect(uuidSchema.safeParse(undefined).success).toBe(false);
  });

  test('should reject numbers', () => {
    expect(uuidSchema.safeParse(12345).success).toBe(false);
    expect(uuidSchema.safeParse(0).success).toBe(false);
  });
});

describe('getUserFromAuth', () => {
  test('enforces the requested audience without falling through to a valid session', async () => {
    const user = await insertTestUser({
      api_token_pepper: 'audience-transition-pepper',
      web_session_pepper: 'current-web-session-pepper',
    });
    const token = signPolicyClaims({
      version: JWT_TOKEN_VERSION,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      env: process.env.NODE_ENV,
      aud: KILO_API_AUDIENCE,
    });
    mockHeaders.mockResolvedValue(
      new Headers({
        authorization: `Bearer ${token}`,
        cookie: 'next-auth.session-token=session',
      })
    );
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'current-web-session-pepper',
    });

    const apiResult = await getUserFromAuth({ adminOnly: false });
    const gatewayResult = await getUserFromAuth({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });

    expect(apiResult.user?.id).toBe(user.id);
    expect(gatewayResult.user).toBeNull();
    expect(gatewayResult.authFailedResponse?.status).toBe(401);
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test('accepts a gateway audience only for a gateway operation', async () => {
    const user = await insertTestUser({ api_token_pepper: 'gateway-audience-pepper' });
    const token = signPolicyClaims({
      version: JWT_TOKEN_VERSION,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      env: process.env.NODE_ENV,
      aud: KILO_GATEWAY_AUDIENCE,
    });
    mockHeaders.mockResolvedValue(new Headers({ authorization: `Bearer ${token}` }));

    const gatewayResult = await getUserFromAuth({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    const apiResult = await getUserFromAuth({ adminOnly: false });

    expect(gatewayResult.user?.id).toBe(user.id);
    expect(apiResult.user).toBeNull();
    expect(apiResult.authFailedResponse?.status).toBe(401);
  });

  test('allows API-token authentication for users from SSO-protected domains', async () => {
    const ssoDomain = `${crypto.randomUUID()}.example.com`;
    const user = await insertTestUser({
      google_user_email: `api-token-user@${ssoDomain}`,
      api_token_pepper: 'api-token-pepper',
    });
    const organization = await createTestOrganization('API Token SSO Domain Org', user.id, 0);
    await db
      .update(organizations)
      .set({ sso_domain: ssoDomain })
      .where(eq(organizations.id, organization.id));

    const token = generateApiToken(user);
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.authFailedResponse).toBeNull();
    expect(result.user?.id).toBe(user.id);
  });

  test('an API token minted before a platform-admin grant cannot reach admin-only paths afterward', async () => {
    // Regression: granting platform admin rotates api_token_pepper, so a
    // bearer token issued while the user was non-admin must stop working
    // rather than silently becoming admin-capable.
    const grantingAdmin = await insertTestUser({
      google_user_email: `granting-admin-${crypto.randomUUID()}@kilocode.ai`,
      hosted_domain: 'kilocode.ai',
      is_admin: true,
      is_super_admin: true,
    });
    const target = await insertTestUser({
      google_user_email: `grant-target-${crypto.randomUUID()}@kilocode.ai`,
      hosted_domain: 'kilocode.ai',
      is_admin: false,
      api_token_pepper: 'pre-grant-pepper',
    });

    const preGrantToken = generateApiToken(target);
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${preGrantToken}` }));

    // Before the grant the token is valid but non-admin: an admin-only check fails.
    const beforeGrant = await getUserFromAuth({ adminOnly: true });
    expect(beforeGrant.authFailedResponse).not.toBeNull();

    const caller = await createCallerForUser(grantingAdmin.id);
    await caller.admin.users.setPlatformAdminAccess({ userId: target.id, isAdmin: true });

    const rotated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, target.id),
    });
    expect(rotated?.is_admin).toBe(true);
    expect(rotated?.api_token_pepper).not.toBe('pre-grant-pepper');

    // The pre-grant token now carries a stale pepper and must be rejected —
    // it must NOT be silently upgraded to admin-capable.
    const afterGrant = await getUserFromAuth({ adminOnly: true });
    expect(afterGrant.authFailedResponse).not.toBeNull();
    expect(afterGrant.user).toBeNull();
  });

  test('Authorization branch threads deviceSessionId from the bearer token', async () => {
    const user = await insertTestUser({
      google_user_email: `api-token-device-session-${crypto.randomUUID()}@example.com`,
      api_token_pepper: 'device-session-pepper',
    });
    const deviceSessionId = crypto.randomUUID();
    const token = generateApiToken(user, { deviceSessionId });
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.authFailedResponse).toBeNull();
    expect(result.user?.id).toBe(user.id);
    expect(result.deviceSessionId).toBe(deviceSessionId);
  });

  test('web-session branch leaves deviceSessionId undefined', async () => {
    const user = await insertTestUser({
      google_user_email: `web-session-claim-${crypto.randomUUID()}@example.com`,
      web_session_pepper: 'web-session-pepper',
    });
    // No Authorization header: auth must come from the web session.
    mockHeaders.mockResolvedValue(new Headers());
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'web-session-pepper',
      isNewUser: false,
    });

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.authFailedResponse).toBeNull();
    expect(result.user?.id).toBe(user.id);
    expect(result.deviceSessionId).toBeUndefined();
  });

  test('failure paths leave deviceSessionId undefined even when the token carried the claim', async () => {
    const user = await insertTestUser({
      google_user_email: `api-token-failure-${crypto.randomUUID()}@example.com`,
      api_token_pepper: 'pre-rotation-pepper',
    });
    const deviceSessionId = crypto.randomUUID();
    const token = generateApiToken(user, { deviceSessionId });
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

    // Rotate the pepper so the bearer token passes JWT verification but fails
    // the pepper comparison — a post-validation failure path.
    await db
      .update(kilocode_users)
      .set({ api_token_pepper: 'rotated-pepper' })
      .where(eq(kilocode_users.id, user.id));

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.authFailedResponse).not.toBeNull();
    expect(result.user).toBeNull();
    expect(result.deviceSessionId).toBeUndefined();
  });
});

describe('credential issuance authentication guards', () => {
  test.each([
    ['Bearer token', { Authorization: 'Bearer token' }],
    ['empty authorization', { Authorization: '' }],
    [
      'cookie and bearer',
      { Authorization: 'Bearer token', Cookie: 'next-auth.session-token=session' },
    ],
  ])('session-only guard rejects %s', async (_name, headers) => {
    mockHeaders.mockResolvedValue(new Headers(headers));

    const result = await getUserFromSessionForCredentialIssuance();

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(401);
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test('uses the genuine session and primary database user', async () => {
    const user = await insertTestUser({ web_session_pepper: 'current-web-session-pepper' });
    mockHeaders.mockResolvedValue(new Headers());
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'current-web-session-pepper',
      isNewUser: false,
    });

    const result = await getUserFromSessionForCredentialIssuance();

    expect(result.user?.id).toBe(user.id);
    expect(mockGetServerSession).toHaveBeenCalledWith(authOptions);
  });

  test('rejects a revoked web session', async () => {
    const user = await insertTestUser({ web_session_pepper: 'current-web-session-pepper' });
    mockHeaders.mockResolvedValue(new Headers());
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: 'revoked-web-session-pepper',
    });

    const result = await getUserFromSessionForCredentialIssuance();

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(401);
  });

  test('does not authorize blocked users for credential issuance', async () => {
    const user = await insertTestUser({ blocked_reason: 'blocked for test' });
    mockHeaders.mockResolvedValue(new Headers());
    mockGetServerSession.mockResolvedValue({ kiloUserId: user.id, webSessionPepper: null });

    const result = await getUserFromSessionForCredentialIssuance();

    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(403);
  });

  test('leaves generic bearer authentication available', async () => {
    const user = await insertTestUser({ api_token_pepper: 'generic-bearer-pepper' });
    mockHeaders.mockResolvedValue(
      new Headers({ Authorization: `Bearer ${generateApiToken(user)}` })
    );

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user?.id).toBe(user.id);
  });

  test('redirects an absent session to the callback-aware sign-in URL', async () => {
    mockHeaders.mockResolvedValue(new Headers({ 'x-pathname': '/profile' }));
    mockGetServerSession.mockResolvedValue(null);

    await expect(getUserFromSessionForCredentialIssuanceOrRedirect()).rejects.toThrow(
      'NEXT_REDIRECT:/users/sign_in?callbackPath=%2Fprofile'
    );
    expect(mockRedirect).toHaveBeenCalledWith('/users/sign_in?callbackPath=%2Fprofile');
  });

  test('redirects blocked sessions to the blocked account page', async () => {
    const user = await insertTestUser({ blocked_reason: 'blocked for test' });
    mockHeaders.mockResolvedValue(new Headers({ 'x-pathname': '/profile' }));
    mockGetServerSession.mockResolvedValue({ kiloUserId: user.id, webSessionPepper: null });

    await expect(getUserFromSessionForCredentialIssuanceOrRedirect()).rejects.toThrow(
      'NEXT_REDIRECT:/account-blocked'
    );
    expect(mockRedirect).toHaveBeenCalledWith('/account-blocked');
  });

  test.each([
    ['bearer', { authorization: 'Bearer token' }],
    ['mixed cookie and bearer', { authorization: 'Bearer token', cookie: 'session=value' }],
  ])('redirects %s authentication to the callback-aware sign-in URL', async (_name, headers) => {
    mockHeaders.mockResolvedValue(new Headers({ ...headers, 'x-pathname': '/profile' }));

    await expect(getUserFromSessionForCredentialIssuanceOrRedirect()).rejects.toThrow(
      'NEXT_REDIRECT:/users/sign_in?callbackPath=%2Fprofile'
    );
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });
});

describe('credential exchange bearer authentication guard', () => {
  async function createModernToken(user: User, pepper = user.api_token_pepper) {
    const now = Math.floor(Date.now() / 1000);
    return signPolicyClaims(
      buildModernKiloTokenPayload({
        userId: user.id,
        pepper,
        env: process.env.NODE_ENV,
        audience: KILO_API_AUDIENCE,
        issuedAt: now,
        expiresAt: now + 300,
        tokenPurpose: 'human-api',
        credentialExchange: true,
      })
    );
  }

  test('authorizes an eligible modern bearer token', async () => {
    const user = await insertTestUser({ api_token_pepper: 'modern-exchange-pepper' });
    const token = await createModernToken(user);

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'deny' }
    );

    expect(result.user?.id).toBe(user.id);
  });

  test.each([157_680_000, 157_788_000])(
    'authorizes eligible legacy bearer tokens with a %i second lifetime',
    async expiresInSeconds => {
      const user = await insertTestUser({ api_token_pepper: `legacy-pepper-${expiresInSeconds}` });
      const { token } = await signKiloToken({
        userId: user.id,
        pepper: user.api_token_pepper,
        secret: NEXTAUTH_SECRET,
        expiresInSeconds,
        env: process.env.NODE_ENV,
      });

      const result = await getUserFromBearerForCredentialExchange(
        new Headers({ authorization: `Bearer ${token}` }),
        { legacy: 'five-year-api' }
      );

      expect(result.user?.id).toBe(user.id);
    }
  );

  test.each([157_680_000, 157_788_000])(
    'authorizes a near-expiry legacy bearer token with a %i second lifetime',
    async lifetime => {
      const user = await insertTestUser({ api_token_pepper: `near-expiry-pepper-${lifetime}` });
      const now = Math.floor(Date.now() / 1000);
      const token = signPolicyClaims({
        version: 3,
        kiloUserId: user.id,
        apiTokenPepper: user.api_token_pepper,
        env: process.env.NODE_ENV,
        iat: now - lifetime + 300,
        exp: now + 300,
      });

      const result = await getUserFromBearerForCredentialExchange(
        new Headers({ authorization: `Bearer ${token}` }),
        { legacy: 'five-year-api' }
      );

      expect(result.user?.id).toBe(user.id);
    }
  );

  test.each([3600, 15 * 60, 24 * 60 * 60, 30 * 24 * 60 * 60])(
    'rejects a %i second legacy bearer token',
    async expiresInSeconds => {
      const user = await insertTestUser({
        api_token_pepper: `short-legacy-pepper-${expiresInSeconds}`,
      });
      const { token } = await signKiloToken({
        userId: user.id,
        pepper: user.api_token_pepper,
        secret: NEXTAUTH_SECRET,
        expiresInSeconds,
        env: process.env.NODE_ENV,
      });

      const result = await getUserFromBearerForCredentialExchange(
        new Headers({ authorization: `Bearer ${token}` }),
        { legacy: 'five-year-api' }
      );

      expect(result.authFailedResponse?.status).toBe(401);
    }
  );

  test('rejects a legacy bearer token when legacy exchange is disabled', async () => {
    const user = await insertTestUser({ api_token_pepper: 'legacy-denied-pepper' });
    const { token } = await signKiloToken({
      userId: user.id,
      pepper: user.api_token_pepper,
      secret: NEXTAUTH_SECRET,
      expiresInSeconds: 157_680_000,
      env: process.env.NODE_ENV,
    });

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'deny' }
    );

    expect(result.authFailedResponse?.status).toBe(401);
  });

  test('rejects absent and mismatched pepper claims, including a null database pepper', async () => {
    const user = await insertTestUser({ api_token_pepper: null });
    const noPepper = await signPolicyClaims({
      version: 3,
      kiloUserId: user.id,
      env: process.env.NODE_ENV,
      aud: KILO_API_AUDIENCE,
      tokenPurpose: 'human-api',
      credentialExchange: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const mismatched = await createModernToken(user, 'different-pepper');

    for (const token of [noPepper, mismatched]) {
      const result = await getUserFromBearerForCredentialExchange(
        new Headers({ authorization: `Bearer ${token}` }),
        { legacy: 'deny' }
      );
      expect(result.authFailedResponse?.status).toBe(401);
    }
  });

  test('accepts an explicit null pepper only when the database pepper is null', async () => {
    const user = await insertTestUser({ api_token_pepper: null });
    const token = await createModernToken(user, null);

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'deny' }
    );

    expect(result.user?.id).toBe(user.id);
  });

  test('rejects an explicit null pepper for a user with a string pepper', async () => {
    const user = await insertTestUser({ api_token_pepper: 'string-pepper' });
    const token = await createModernToken(user, null);

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'deny' }
    );

    expect(result.authFailedResponse?.status).toBe(401);
  });

  test('rejects a token after its database pepper is rotated', async () => {
    const user = await insertTestUser({ api_token_pepper: 'before-rotation-pepper' });
    const token = await createModernToken(user);
    await db
      .update(kilocode_users)
      .set({ api_token_pepper: 'after-rotation-pepper' })
      .where(eq(kilocode_users.id, user.id));

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'deny' }
    );

    expect(result.authFailedResponse?.status).toBe(401);
  });

  test.each([
    [
      'missing environment',
      (user: User, now: number) => ({
        version: 3,
        kiloUserId: user.id,
        apiTokenPepper: user.api_token_pepper,
        aud: KILO_API_AUDIENCE,
        tokenPurpose: 'human-api',
        credentialExchange: true,
        iat: now,
        exp: now + 300,
      }),
    ],
    [
      'device purpose',
      (user: User, now: number) => ({
        version: 3,
        kiloUserId: user.id,
        apiTokenPepper: user.api_token_pepper,
        env: process.env.NODE_ENV,
        aud: KILO_API_AUDIENCE,
        tokenPurpose: 'device-access',
        credentialExchange: false,
        iat: now,
        exp: now + 300,
      }),
    ],
    [
      'unknown signed claim',
      (user: User, now: number) => ({
        version: 3,
        kiloUserId: user.id,
        apiTokenPepper: user.api_token_pepper,
        env: process.env.NODE_ENV,
        aud: KILO_API_AUDIENCE,
        tokenPurpose: 'human-api',
        credentialExchange: true,
        futureRestriction: false,
        iat: now,
        exp: now + 300,
      }),
    ],
  ])('rejects an eligible-looking token with %s', async (_name, claimsFor) => {
    const user = await insertTestUser({ api_token_pepper: 'ineligible-claim-pepper' });
    const token = await signPolicyClaims(claimsFor(user, Math.floor(Date.now() / 1000)));

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'five-year-api' }
    );

    expect(result.authFailedResponse?.status).toBe(401);
  });

  test.each([
    ['device session', { deviceSessionId: '' }],
    ['bot', { botId: '' }],
    ['organization', { organizationId: '' }],
    ['token source', { tokenSource: '' }],
    ['admin', { isAdmin: false }],
    ['internal use', { internalApiUse: false }],
    ['gastown access', { gastownAccess: false }],
  ])('rejects a legacy bearer token with a %s marker', async (_name, marker) => {
    const user = await insertTestUser({ api_token_pepper: 'system-marker-pepper' });
    const now = Math.floor(Date.now() / 1000);
    const token = signPolicyClaims({
      version: 3,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      env: process.env.NODE_ENV,
      iat: now,
      exp: now + 157_680_000,
      ...marker,
    });

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'five-year-api' }
    );

    expect(result.authFailedResponse?.status).toBe(401);
  });

  test.each([
    'invalid signature',
    'expired',
    'future-issued',
    'missing expiry',
    'missing issuance',
  ])('rejects an otherwise eligible token with %s without a session fallback', async invalidity => {
    const user = await insertTestUser({ api_token_pepper: 'verification-test-pepper' });
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = buildModernKiloTokenPayload({
      userId: user.id,
      pepper: user.api_token_pepper,
      env: process.env.NODE_ENV,
      audience: KILO_API_AUDIENCE,
      issuedAt: now,
      expiresAt: now + 300,
      tokenPurpose: 'human-api',
      credentialExchange: true,
    });
    if (invalidity === 'expired') {
      claims.iat = now - 600;
      claims.exp = now - 300;
    } else if (invalidity === 'future-issued') {
      claims.iat = now + 300;
      claims.exp = now + 600;
    } else if (invalidity === 'missing expiry') {
      delete claims.exp;
    }
    const token = jwt.sign(
      claims,
      invalidity === 'invalid signature' ? 'wrong-test-signing-secret' : NEXTAUTH_SECRET,
      { algorithm: 'HS256', noTimestamp: invalidity === 'missing issuance' }
    );

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'deny' }
    );

    expect(result.authFailedResponse?.status).toBe(401);
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test('rejects a valid token for a missing user', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signPolicyClaims({
      version: 3,
      kiloUserId: 'missing-credential-exchange-user',
      apiTokenPepper: 'pepper',
      env: process.env.NODE_ENV,
      aud: KILO_API_AUDIENCE,
      tokenPurpose: 'human-api',
      credentialExchange: true,
      iat: now,
      exp: now + 300,
    });

    const result = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${token}` }),
      { legacy: 'deny' }
    );

    expect(result.authFailedResponse?.status).toBe(401);
  });

  test('rejects wrong audiences, environment, blocked users, and ineligible modern claims', async () => {
    const user = await insertTestUser({ api_token_pepper: 'rejected-exchange-pepper' });
    const now = Math.floor(Date.now() / 1000);
    const invalidClaims = [
      {
        version: 3,
        kiloUserId: user.id,
        apiTokenPepper: user.api_token_pepper,
        env: process.env.NODE_ENV,
        aud: 'other-audience',
        tokenPurpose: 'human-api',
        credentialExchange: true,
        iat: now,
        exp: now + 300,
      },
      buildModernKiloTokenPayload({
        userId: user.id,
        pepper: user.api_token_pepper,
        env: 'other-environment',
        audience: KILO_API_AUDIENCE,
        issuedAt: now,
        expiresAt: now + 300,
        tokenPurpose: 'human-api',
        credentialExchange: true,
      }),
      buildModernKiloTokenPayload({
        userId: user.id,
        pepper: user.api_token_pepper,
        env: process.env.NODE_ENV,
        audience: KILO_API_AUDIENCE,
        issuedAt: now,
        expiresAt: now + 300,
        tokenPurpose: 'human-api',
        credentialExchange: false,
      }),
    ];

    for (const claims of invalidClaims) {
      const result = await getUserFromBearerForCredentialExchange(
        new Headers({ authorization: `Bearer ${await signPolicyClaims(claims)}` }),
        { legacy: 'deny' }
      );
      expect(result.authFailedResponse?.status).toBe(401);
    }

    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'blocked for test' })
      .where(eq(kilocode_users.id, user.id));
    const blocked = await getUserFromBearerForCredentialExchange(
      new Headers({ authorization: `Bearer ${await createModernToken(user)}` }),
      { legacy: 'deny' }
    );
    expect(blocked.authFailedResponse?.status).toBe(403);
  });
});

describe('getUserFromAuth admin_access telemetry (REST)', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
  });

  afterEach(() => {
    setAdminAccessSinkForTest(null);
  });

  test('emits one rest/token event for an authorized admin via API token', async () => {
    const admin = await insertTestUser({
      google_user_email: `rest-admin-${crypto.randomUUID()}@kilocode.ai`,
      hosted_domain: 'kilocode.ai',
      is_admin: true,
      is_super_admin: true,
      api_token_pepper: 'rest-admin-pepper',
    });
    const token = generateApiToken(admin);
    mockHeaders.mockResolvedValue(
      new Headers({
        Authorization: `Bearer ${token}`,
        'x-pathname': '/admin/api/safety-identifiers',
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      })
    );

    const result = await getUserFromAuth({ adminOnly: true });

    expect(result.user?.id).toBe(admin.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'admin_access',
      surface: 'rest',
      kind: 'admin_guard',
      authVia: 'token',
      adminTier: 'super_admin',
      kiloUserId: admin.id,
      email: admin.google_user_email,
      route: '/admin/api/safety-identifiers',
      method: null,
      ip: '203.0.113.7',
      tokenSource: null,
    });
  });

  test('does not emit when a non-admin token hits an admin-only check', async () => {
    const nonAdmin = await insertTestUser({
      is_admin: false,
      api_token_pepper: 'rest-nonadmin-pepper',
    });
    const token = generateApiToken(nonAdmin);
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

    const result = await getUserFromAuth({ adminOnly: true });

    expect(result.authFailedResponse).not.toBeNull();
    expect(events).toHaveLength(0);
  });

  test('does not emit for adminOnly:false calls even for an admin', async () => {
    const admin = await insertTestUser({
      is_admin: true,
      api_token_pepper: 'rest-admin-noemit-pepper',
    });
    const token = generateApiToken(admin);
    mockHeaders.mockResolvedValue(new Headers({ Authorization: `Bearer ${token}` }));

    const result = await getUserFromAuth({ adminOnly: false });

    expect(result.user?.id).toBe(admin.id);
    expect(events).toHaveLength(0);
  });
});

describe('parseSignInRedirectContext', () => {
  test('returns empty context when cookie value is undefined', () => {
    expect(parseSignInRedirectContext(undefined)).toEqual({});
  });

  test('returns empty context when cookie value is empty string', () => {
    expect(parseSignInRedirectContext('')).toEqual({});
  });

  test('returns empty context for malformed URL', () => {
    expect(parseSignInRedirectContext('::::not a url::::')).toEqual({});
  });

  test('extracts callbackPath from /users/after-sign-in destination', () => {
    const cookie = '/users/after-sign-in?callbackPath=%2Fdevice-auth%3Fcode%3Dabc123';
    expect(parseSignInRedirectContext(cookie)).toEqual({
      callbackPath: '/device-auth?code=abc123',
    });
  });

  test('extracts signup=true flag', () => {
    const cookie = '/users/after-sign-in?signup=true';
    expect(parseSignInRedirectContext(cookie)).toEqual({
      signup: true,
    });
  });

  test('extracts both callbackPath and signup together', () => {
    const cookie = '/users/after-sign-in?callbackPath=%2Fdevice-auth%3Fcode%3Dabc123&signup=true';
    expect(parseSignInRedirectContext(cookie)).toEqual({
      callbackPath: '/device-auth?code=abc123',
      signup: true,
    });
  });

  test('rejects callbackPath that fails isValidCallbackPath', () => {
    const cookie = '/users/after-sign-in?callbackPath=https%3A%2F%2Fevil.example.com%2Fphish';
    expect(parseSignInRedirectContext(cookie)).toEqual({});
  });

  test('treats signup values other than "true" as absent', () => {
    const cookie = '/users/after-sign-in?signup=false';
    expect(parseSignInRedirectContext(cookie)).toEqual({});
  });

  test('handles absolute URL cookie value', () => {
    const cookie = 'https://kilo.ai/users/after-sign-in?callbackPath=%2Fdevice-auth%3Fcode%3Dxyz';
    expect(parseSignInRedirectContext(cookie)).toEqual({
      callbackPath: '/device-auth?code=xyz',
    });
  });
});

describe('getProfileRedirectPath', () => {
  let hardExpiredUser: User;
  let hardExpiredOrganization: Organization;
  let pastDueUser: User;
  let pastDueOrganization: Organization;

  beforeAll(async () => {
    hardExpiredUser = await insertTestUser({
      google_user_name: 'Hard Expired Redirect User',
    });
    hardExpiredOrganization = await createTestOrganization(
      'Hard Expired Redirect Org',
      hardExpiredUser.id,
      100_000,
      undefined,
      true
    );
    await db
      .update(organizations)
      .set({
        free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .where(eq(organizations.id, hardExpiredOrganization.id));

    pastDueUser = await insertTestUser({
      google_user_name: 'Past Due Redirect User',
    });
    pastDueOrganization = await createTestOrganization(
      'Past Due Redirect Org',
      pastDueUser.id,
      100_000,
      undefined,
      true
    );
    await db
      .update(organizations)
      .set({
        free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .where(eq(organizations.id, pastDueOrganization.id));
    await db.insert(organization_seats_purchases).values({
      organization_id: pastDueOrganization.id,
      subscription_stripe_id: 'sub_profile_redirect_past_due',
      subscription_status: 'past_due',
      seat_count: 2,
      amount_usd: 42,
      starts_at: '2026-04-01T00:00:00.000Z',
      expires_at: '2027-04-01T00:00:00.000Z',
      billing_cycle: 'yearly',
    });
  });

  test('redirects hard-expired single-organization users to profile without entitlement', async () => {
    await expect(getProfileRedirectPath(hardExpiredUser)).resolves.toBe('/profile');
  });

  test('keeps past-due seat purchase organizations on their organization page', async () => {
    await expect(getProfileRedirectPath(pastDueUser)).resolves.toBe(
      `/organizations/${pastDueOrganization.id}`
    );
  });

  test('redirects to the sales demo org when the user also has an older non-demo org', async () => {
    const user = await insertTestUser({
      google_user_name: 'Sales Demo Redirect User',
    });
    const olderOrg = await createTestOrganization('Older Non-Demo Org', user.id, 100_000);
    await db
      .update(organizations)
      .set({ created_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(organizations.id, olderOrg.id));

    const demoOrg = await createTestOrganization('Sales Demo Redirect Org', user.id, 0, {
      is_sales_demo: true,
    });

    await expect(getProfileRedirectPath(user)).resolves.toBe(`/organizations/${demoOrg.id}`);
  });

  test('prefers a permitted verified-domain organization over unrelated memberships', async () => {
    const user = await insertTestUser({
      google_user_name: 'Verified Domain Redirect User',
      google_user_email: 'person@redirect-preferred.example.com',
    });
    await createTestOrganization('Unrelated Redirect Org', user.id, 100_000);
    const preferred = await createTestOrganization('Preferred Redirect Org', user.id, 100_000);
    await db.insert(organization_domain_claims).values({
      organization_id: preferred.id,
      domain: 'redirect-preferred.example.com',
      status: 'verified',
      workos_organization_id: `workos-org-${crypto.randomUUID()}`,
      workos_domain_id: `workos-domain-${crypto.randomUUID()}`,
      verified_at: new Date().toISOString(),
    });

    await expect(getProfileRedirectPath(user)).resolves.toBe(`/organizations/${preferred.id}`);
  });

  describe('users with personal account disabled', () => {
    test('redirects multi-organization users to one of their organizations', async () => {
      const invitedUser = await insertTestUser({
        google_user_name: 'Invited Multi Org User',
        personal_account_disabled: true,
      });
      const orgA = await createTestOrganization('Invited Org A', invitedUser.id, 100_000);
      const orgB = await createTestOrganization('Invited Org B', invitedUser.id, 100_000);

      await expect(getProfileRedirectPath(invitedUser)).resolves.toMatch(
        new RegExp(`^/organizations/(${orgA.id}|${orgB.id})$`)
      );
    });

    test('falls back to connected accounts when the user has no organizations', async () => {
      const orphanUser = await insertTestUser({
        google_user_name: 'Invited Orphan User',
        personal_account_disabled: true,
      });

      await expect(getProfileRedirectPath(orphanUser)).resolves.toBe('/connected-accounts');
    });
  });
});
