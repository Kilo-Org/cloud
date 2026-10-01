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

import { beforeEach, describe, test, expect } from '@jest/globals';
import { getUserFromAuth, sessionAuthOptions } from '@kilocode/web-shared/lib/user/server';
import {
  parseLinkedInProfileName,
  parseAnacondaProfile,
  parseOpenAiProfile,
  profileProvesEmailOwnership,
  authOptions,
  parseSignInRedirectContext,
} from './next-auth-options';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createSignInTicket } from '@/lib/auth/passkey';
import {
  openai_chatgpt_connections,
  kilocode_users,
  organizations,
  passkey_sign_in_tickets,
  user_auth_provider,
} from '@kilocode/db/schema';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { and, eq, isNull } from 'drizzle-orm';
import type { Account, Profile } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { OPENAI_CLIENT_ID } from '@kilocode/web-shared/lib/config.server';
import {
  OPENAI_IDENTITY_SCOPE,
  OPENAI_ISSUER,
  OPENAI_REDIRECT_URI,
  OPENAI_TOKEN_SHARING_SCOPE,
} from '@kilocode/web-shared/lib/auth/openai/config';
import { hosted_domain_specials } from '@kilocode/web-shared/lib/auth/constants';
import { getOpenAiChatGptConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';

beforeEach(() => {
  mockHeaders.mockReset();
  mockGetServerSession.mockReset();
  mockRedirect.mockClear();
});

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

describe('OpenAI (ChatGPT) OAuth provider', () => {
  test('maps verified claims and uses sub as the stable account id', () => {
    expect(
      parseOpenAiProfile({
        sub: 'openai-user-123',
        email: 'user@example.com',
        name: 'ChatGPT User',
        picture: 'https://example.com/avatar.png',
        email_verified: true,
      })
    ).toEqual({
      id: 'openai-user-123',
      email: 'user@example.com',
      name: 'ChatGPT User',
      image: 'https://example.com/avatar.png',
    });
  });

  test('uses the email local part and null image when the profile omits them', () => {
    expect(parseOpenAiProfile({ sub: 'openai-user-123', email: 'local-part@example.com' })).toEqual(
      {
        id: 'openai-user-123',
        email: 'local-part@example.com',
        name: 'local-part',
        image: null,
      }
    );
  });

  test.each([
    [{ email: 'user@example.com' }, 'missing subject'],
    [{ sub: '', email: 'user@example.com' }, 'empty subject'],
    [{ sub: 'openai-user-123' }, 'missing email'],
    [{ sub: 'openai-user-123', email: 'not-an-email' }, 'invalid email'],
  ])('rejects a profile with %s (%s)', (profile, _reason) => {
    expect(() => parseOpenAiProfile(profile)).toThrow();
  });

  test('registers the registered callback path, ID tokens, OIDC checks and confidential-client auth', () => {
    const provider = authOptions.providers.find(p => p.id === 'openai') as unknown as
      | {
          id: string;
          name: string;
          type: string;
          issuer: string;
          idToken: boolean;
          checks: string[];
          client: { token_endpoint_auth_method: string; redirect_uris?: string[] };
          clientId: string;
          callbackUrl: string;
          token: { request?: unknown };
        }
      | undefined;

    expect(provider).toMatchObject({
      id: 'openai',
      name: 'ChatGPT',
      type: 'oauth',
      issuer: 'https://auth.openai.com',
      idToken: true,
      client: { token_endpoint_auth_method: 'client_secret_basic' },
      clientId: OPENAI_CLIENT_ID,
    });
    expect(provider?.checks).toEqual(expect.arrayContaining(['pkce', 'state', 'nonce']));
    expect(provider?.callbackUrl.endsWith('/auth/openai/callback')).toBe(true);
    // NextAuth rewrites `callbackUrl` to /api/auth/callback/openai, so the
    // registered redirect URI is declared on the client metadata and repeated
    // in the token exchange.
    expect(provider?.client.redirect_uris).toEqual([OPENAI_REDIRECT_URI]);
    expect(provider?.token.request).toBeInstanceOf(Function);
  });
});

describe('sessionAuthOptions', () => {
  test('reads a session with the same configuration as authOptions', async () => {
    expect(authOptions.secret).toBe(sessionAuthOptions.secret);
    expect(authOptions.logger).toBe(sessionAuthOptions.logger);
    expect(authOptions.pages).toBe(sessionAuthOptions.pages);
    expect(authOptions.debug).toBe(sessionAuthOptions.debug);
    expect(authOptions.callbacks?.session).toBe(sessionAuthOptions.callbacks.session);

    // A session read runs the jwt callback without a trigger.
    const token = { kiloUserId: 'user-id', version: 3 } as JWT;
    await expect(authOptions.callbacks?.jwt?.({ token } as never)).resolves.toBe(token);
    await expect(sessionAuthOptions.callbacks.jwt({ token } as never)).resolves.toBe(token);
  });
});

describe('OpenAI (ChatGPT) sign-in connection persistence', () => {
  const jwtCallback = authOptions.callbacks?.jwt;

  async function seedOpenAiUser(sub: string) {
    const email = `openai-${crypto.randomUUID()}@example.com`;
    const user = await insertTestUser({
      google_user_email: email,
      google_user_name: 'ChatGPT User',
    });
    await db.insert(user_auth_provider).values({
      kilo_user_id: user.id,
      provider: 'openai',
      provider_account_id: `${OPENAI_ISSUER}#${sub}`,
      email,
      avatar_url: '',
      hosted_domain: hosted_domain_specials.openai,
    });
    return { user, email };
  }

  function openAiSignInArgs(
    userId: string,
    email: string,
    sub: string,
    accountOverrides: Partial<Account> = {}
  ) {
    return {
      token: {} as JWT,
      account: {
        provider: 'openai',
        type: 'oauth' as const,
        providerAccountId: `openai-account-${sub}`,
        access_token: 'signin-access-token',
        refresh_token: 'signin-refresh-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        scope: OPENAI_TOKEN_SHARING_SCOPE,
        token_type: 'Bearer',
        ...accountOverrides,
      },
      user: { id: userId, email, name: 'ChatGPT User', image: null },
      profile: { sub, email, name: 'ChatGPT User' } as Profile,
      trigger: 'signIn' as const,
    };
  }

  test('persists the delegated connection for the resolved user', async () => {
    const sub = `subject-${crypto.randomUUID()}`;
    const { user, email } = await seedOpenAiUser(sub);

    const token = await jwtCallback!(openAiSignInArgs(user.id, email, sub));

    expect(token.kiloUserId).toBe(user.id);
    await expect(
      getOpenAiChatGptConnection({ kiloUserId: user.id, organizationId: null })
    ).resolves.toMatchObject({
      access_token: 'signin-access-token',
      refresh_token: 'signin-refresh-token',
      issuer: OPENAI_ISSUER,
      client_id: OPENAI_CLIENT_ID,
      subject: sub,
      email,
      status: 'connected',
    });

    const [row] = await db
      .select()
      .from(openai_chatgpt_connections)
      .where(
        and(
          eq(openai_chatgpt_connections.kilo_user_id, user.id),
          isNull(openai_chatgpt_connections.organization_id)
        )
      );
    expect(row?.is_enabled).toBe(true);
  });

  test('persists an organization connection when the profile carries the organization', async () => {
    const sub = `subject-${crypto.randomUUID()}`;
    const { user, email } = await seedOpenAiUser(sub);
    const organization = await createTestOrganization(
      `ChatGPT BYOK ${crypto.randomUUID()}`,
      user.id,
      0
    );

    const args = openAiSignInArgs(user.id, email, sub);
    (args.profile as Record<string, unknown>).openAiChatGptOrganizationId = organization.id;

    await jwtCallback!(args);

    await expect(
      getOpenAiChatGptConnection({ kiloUserId: user.id, organizationId: organization.id })
    ).resolves.toMatchObject({
      access_token: 'signin-access-token',
      refresh_token: 'signin-refresh-token',
      subject: sub,
      status: 'connected',
    });

    await db.delete(organizations).where(eq(organizations.id, organization.id));
  });

  test('does not store a connection for an identity-only sign-in', async () => {
    const sub = `subject-${crypto.randomUUID()}`;
    const { user, email } = await seedOpenAiUser(sub);

    await jwtCallback!(
      openAiSignInArgs(user.id, email, sub, {
        scope: OPENAI_IDENTITY_SCOPE,
        refresh_token: undefined,
      })
    );

    await expect(
      getOpenAiChatGptConnection({ kiloUserId: user.id, organizationId: null })
    ).resolves.toBeNull();
  });

  test('does not overwrite a working connection with an identity-only sign-in', async () => {
    const sub = `subject-${crypto.randomUUID()}`;
    const { user, email } = await seedOpenAiUser(sub);
    await jwtCallback!(openAiSignInArgs(user.id, email, sub));

    await jwtCallback!(
      openAiSignInArgs(user.id, email, sub, {
        scope: OPENAI_IDENTITY_SCOPE,
        refresh_token: undefined,
        access_token: 'identity-only-access-token',
        expires_at: Math.floor(Date.now() / 1000) + 60,
      })
    );

    await expect(
      getOpenAiChatGptConnection({ kiloUserId: user.id, organizationId: null })
    ).resolves.toMatchObject({
      access_token: 'signin-access-token',
      refresh_token: 'signin-refresh-token',
    });
  });

  test('stores the delegated connection when a grant omits the scope but returns a refresh token', async () => {
    const sub = `subject-${crypto.randomUUID()}`;
    const { user, email } = await seedOpenAiUser(sub);

    // RFC 6749 §5.1 lets the token response omit `scope` when it equals the
    // requested scope; the refresh token is then the delegated grant's marker.
    await jwtCallback!(openAiSignInArgs(user.id, email, sub, { scope: undefined }));

    await expect(
      getOpenAiChatGptConnection({ kiloUserId: user.id, organizationId: null })
    ).resolves.toMatchObject({
      access_token: 'signin-access-token',
      refresh_token: 'signin-refresh-token',
    });
  });

  test('does not fail the sign-in when storing the connection fails', async () => {
    const sub = `subject-${crypto.randomUUID()}`;
    const { user, email } = await seedOpenAiUser(sub);
    const originalInsert = (db.insert as unknown as (table: unknown) => unknown).bind(db);
    const insertSpy = jest.spyOn(db, 'insert').mockImplementation(((table: unknown) => {
      if (table === openai_chatgpt_connections) throw new Error('simulated storage failure');
      return originalInsert(table);
    }) as unknown as typeof db.insert);

    try {
      const token = await jwtCallback!(openAiSignInArgs(user.id, email, sub));
      expect(token.kiloUserId).toBe(user.id);
    } finally {
      insertSpy.mockRestore();
    }

    const rows = await db
      .select()
      .from(openai_chatgpt_connections)
      .where(eq(openai_chatgpt_connections.kilo_user_id, user.id));
    expect(rows).toHaveLength(0);
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

describe('getUserFromAuth', () => {
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

type PasskeyAuthorizeResult = {
  id: string;
  email: string;
  name: string;
  image: string;
} | null;

type PasskeyProviderConfig = {
  id?: string;
  name?: string;
  credentials?: Record<string, unknown>;
  authorize?: (credentials: { ticket: string } | undefined) => unknown;
};

/**
 * next-auth v4 keeps a CredentialsProvider's user config under `options` until
 * the request-scoped normalization merges it onto the provider, so the raw
 * `authOptions.providers` entries for both `email` and `passkey` read
 * `id: 'credentials'`. Resolve the user config the way next-auth does.
 */
function passkeyProviderConfigs(): PasskeyProviderConfig[] {
  return authOptions.providers.map(candidate => ({
    id: candidate.id,
    ...((candidate as { options?: PasskeyProviderConfig }).options ?? {}),
  }));
}

function getPasskeyAuthorize() {
  const config = passkeyProviderConfigs().find(candidate => candidate.id === 'passkey');
  if (!config || typeof config.authorize !== 'function') {
    throw new Error('Passkey credentials provider is not registered');
  }
  return config.authorize as unknown as (
    credentials: { ticket: string } | undefined
  ) => Promise<PasskeyAuthorizeResult>;
}

describe('passkey provider', () => {
  test('registers a passkey credentials provider that exchanges a ticket', () => {
    expect(passkeyProviderConfigs().find(candidate => candidate.id === 'passkey')).toMatchObject({
      name: 'Passkey',
      credentials: { ticket: expect.anything() },
    });
  });

  test('a ticket authorizes its owner and a replayed ticket mints no session', async () => {
    const authorize = getPasskeyAuthorize();
    const user = await insertTestUser({ google_user_name: 'Passkey Owner' });
    const ticket = await createSignInTicket(user.id);

    await expect(authorize({ ticket })).resolves.toEqual({
      id: user.id,
      email: user.google_user_email,
      name: 'Passkey Owner',
      image: user.google_user_image_url,
    });

    // A ticket is single-use: the atomic redemption consumed the row, so the
    // replay resolves no user and NextAuth mints no session for it.
    await expect(authorize({ ticket })).resolves.toBeNull();
    await expect(authorize({ ticket: 'not-a-ticket' })).resolves.toBeNull();
    await expect(authorize(undefined)).resolves.toBeNull();

    // No `user_auth_provider` row is written for a passkey.
    const providerRows = await db
      .select({ provider: user_auth_provider.provider })
      .from(user_auth_provider)
      .where(eq(user_auth_provider.kilo_user_id, user.id));
    expect(providerRows).toEqual([]);
  });

  test('an expired ticket is refused', async () => {
    const authorize = getPasskeyAuthorize();
    const user = await insertTestUser();
    const ticket = await createSignInTicket(user.id);
    await db
      .update(passkey_sign_in_tickets)
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(passkey_sign_in_tickets.kilo_user_id, user.id));

    await expect(authorize({ ticket })).resolves.toBeNull();
  });

  test('the jwt callback resolves a passkey by user id and sets the session claims', async () => {
    const user = await insertTestUser({
      google_user_name: 'Passkey Jwt User',
      web_session_pepper: 'passkey-web-session-pepper',
    });
    const jwtCallback = authOptions.callbacks!.jwt!;

    const token = await jwtCallback({
      token: {},
      account: { provider: 'passkey', providerAccountId: user.id, type: 'credentials' },
      user: { id: user.id, email: user.google_user_email },
      trigger: 'signIn',
      profile: undefined,
      isNewUser: false,
      session: undefined,
    } as never);

    expect(token.kiloUserId).toBe(user.id);
    expect(token.authProvider).toBe('passkey');
    expect(token.webSessionPepper).toBe('passkey-web-session-pepper');
  });
});
