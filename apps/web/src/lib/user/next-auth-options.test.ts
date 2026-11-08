import type * as watchwoodModule from '@/lib/auth/watchwood';
import type * as linkingModule from '@/lib/account-linking-session';
import type * as userModule from '@/lib/user';
import type * as userServerModule from '@kilocode/web-shared/lib/user/server';

jest.mock('next/headers', () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock('@/lib/auth/watchwood', () => ({
  ...jest.requireActual<typeof watchwoodModule>('@/lib/auth/watchwood'),
  readWatchwoodSignupAssessment: jest.fn(),
}));
jest.mock('@/lib/user/sso', () => ({ processSSOUserLogin: jest.fn() }));
jest.mock('@/lib/user', () => ({
  ...jest.requireActual<typeof userModule>('@/lib/user'),
  findAndSyncExistingUser: jest.fn(
    jest.requireActual<typeof userModule>('@/lib/user').findAndSyncExistingUser
  ),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  ...jest.requireActual<typeof userServerModule>('@kilocode/web-shared/lib/user/server'),
  getUserFromSession: jest.fn(),
  isEmailBlacklistedByDomainAsync: jest.fn(),
  isBlockedTLD: jest.fn(),
}));
jest.mock('@/lib/account-linking-session', () => ({
  ...jest.requireActual<typeof linkingModule>('@/lib/account-linking-session'),
  getAccountLinkingSession: jest.fn(),
}));

import { describe, test, expect } from '@jest/globals';
import { cookies, headers } from 'next/headers';
import { readWatchwoodSignupAssessment } from '@/lib/auth/watchwood';
import { processSSOUserLogin } from '@/lib/user/sso';
import { getAccountLinkingSession } from '@/lib/account-linking-session';
import * as userServer from '@kilocode/web-shared/lib/user/server';
import * as userLib from '@/lib/user';
import { sessionAuthOptions } from '@kilocode/web-shared/lib/user/server';
import {
  parseLinkedInProfileName,
  parseAnacondaProfile,
  parseOpenAiProfile,
  profileProvesEmailOwnership,
  authOptions,
  parseSignInRedirectContext,
  getInvitationTokenFromCallbackPath,
  preserveSignInRedirectContext,
} from '@/lib/user/next-auth-options';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createSignInTicket } from '@/lib/auth/passkey';
import getSignInCallbackUrl from '@/lib/getSignInCallbackUrl';
import {
  openai_chatgpt_connections,
  organizations,
  passkey_sign_in_tickets,
  user_auth_provider,
} from '@kilocode/db/schema';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
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

describe('Discord OAuth provider', () => {
  test('configures the issuer for Discord authorization responses', () => {
    expect(authOptions.providers.find(provider => provider.id === 'discord')).toMatchObject({
      authorization: 'https://discord.com/api/oauth2/authorize?scope=identify+email',
      token: 'https://discord.com/api/oauth2/token',
      userinfo: 'https://discord.com/api/users/@me',
      options: { issuer: 'https://discord.com' },
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
    // Server reads keep the per-session claim; the browser-facing session
    // callback wraps it and removes that claim.
    expect(authOptions.callbacks?.session).not.toBe(sessionAuthOptions.callbacks.session);

    // A session read runs the jwt callback without a trigger.
    const token = { kiloUserId: 'user-id', version: 3 } as JWT;
    await expect(authOptions.callbacks?.jwt?.({ token } as never)).resolves.toBe(token);
    await expect(sessionAuthOptions.callbacks.jwt({ token } as never)).resolves.toBe(token);
  });

  test('server reads expose webSessionId and the browser response strips it', async () => {
    const token = {
      kiloUserId: 'user-id',
      version: 3,
      webSessionId: 'per-session-id',
    } as JWT;
    const session = {
      user: { id: 'user-id', email: 'user@example.com' },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as never;

    const serverSession = await sessionAuthOptions.callbacks.session({ session, token } as never);
    expect(serverSession.webSessionId).toBe('per-session-id');

    const browserSession = await authOptions.callbacks!.session!({ session, token } as never);
    expect(browserSession).not.toHaveProperty('webSessionId');
    expect(browserSession).not.toHaveProperty('webSessionPepper');
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

describe('getInvitationTokenFromCallbackPath', () => {
  test('extracts an invitation token from the WorkOS sign-in callback URL', () => {
    const callbackUrl = getSignInCallbackUrl({ callbackPath: '/users/accept-invite/invite-token' });
    const context = parseSignInRedirectContext(callbackUrl);
    expect(getInvitationTokenFromCallbackPath(context.callbackPath)).toBe('invite-token');
  });

  test('decodes the token and ignores the query and fragment', () => {
    expect(getInvitationTokenFromCallbackPath('/users/accept-invite/invite%2Dtoken?x=1#next')).toBe(
      'invite-token'
    );
  });

  test.each([
    undefined,
    '/users/accept-invite',
    '/users/accept-invite/',
    '/users/accept-invite/token/more',
    '/users/accept-invited/token',
    'https://example.com/users/accept-invite/token',
    '/users/accept-invite/%invalid',
  ])('ignores non-invitation or malformed callback %s', callback => {
    expect(getInvitationTokenFromCallbackPath(callback)).toBeUndefined();
  });
});

describe('preserveSignInRedirectContext', () => {
  test('preserves the invitation when SSO sign-in fails or is enforced', () => {
    for (const url of [
      '/users/sign_in?error=OAUTH_ERROR',
      '/users/sign_in?sso=true&domain=example.com',
    ]) {
      const result = new URL(
        preserveSignInRedirectContext(url, {
          callbackPath: '/users/accept-invite/invite-token',
        }),
        'https://example.com'
      );
      expect(result.searchParams.get('callbackPath')).toBe('/users/accept-invite/invite-token');
    }
  });

  test('does not preserve an unsafe callback', () => {
    expect(
      preserveSignInRedirectContext('/users/sign_in?error=OAUTH_ERROR', {
        callbackPath: 'https://evil.example.com',
      })
    ).toBe('/users/sign_in?error=OAUTH_ERROR');
  });
});

describe('WorkOS sign-in callback', () => {
  const callbackPath = '/users/accept-invite/invite-token';
  const requestHeaders = new Headers({ 'accept-language': 'en-US', 'x-vercel-ip-country': 'US' });
  const watchwood = { status: 'assessed', riskScore: 0.4, latencyMs: 12, assessedAt: 123 } as const;
  const signInArgs = {
    user: { id: 'workos-user', email: 'user@example.com', name: 'Test User', image: null },
    account: { provider: 'workos', providerAccountId: 'workos-user', type: 'oauth' as const },
    profile: undefined,
  };

  beforeEach(() => {
    const callbackUrl = getSignInCallbackUrl({ callbackPath });
    jest.mocked(cookies).mockResolvedValue({
      get: (name: string) => {
        if (name === 'next-auth.callback-url') return { name, value: callbackUrl };
        if (name === 'impact_click_id') return { name, value: 'impact-click' };
        return undefined;
      },
    } as Awaited<ReturnType<typeof cookies>>);
    jest.mocked(headers).mockResolvedValue(requestHeaders as Awaited<ReturnType<typeof headers>>);
    jest.mocked(getAccountLinkingSession).mockResolvedValue(null);
    jest.mocked(readWatchwoodSignupAssessment).mockResolvedValue(watchwood);
    jest.mocked(processSSOUserLogin).mockResolvedValue(true);
    jest.mocked(userLib.findAndSyncExistingUser).mockResolvedValue(null);
    jest.mocked(userServer.isEmailBlacklistedByDomainAsync).mockResolvedValue(false);
    jest.mocked(userServer.isBlockedTLD).mockResolvedValue(false);
  });

  afterEach(() => {
    jest
      .mocked(userLib.findAndSyncExistingUser)
      .mockImplementation(
        jest.requireActual<typeof userModule>('@/lib/user').findAndSyncExistingUser
      );
    jest.clearAllMocks();
  });

  test('forwards the Watchwood assessment, tracking context and invitation token', async () => {
    await expect(authOptions.callbacks!.signIn!(signInArgs)).resolves.toBe(true);

    expect(processSSOUserLogin).toHaveBeenCalledTimes(1);
    expect(processSSOUserLogin).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'workos', google_user_email: 'user@example.com' }),
      requestHeaders,
      'impact-click',
      expect.objectContaining({ watchwood, locale: 'en-US', countryCode: 'US' }),
      'invite-token'
    );
  });

  test('preserves the invitation callback on an SSO error redirect', async () => {
    jest.mocked(processSSOUserLogin).mockResolvedValue('/users/sign_in?error=OAUTH_ERROR');

    const result = await authOptions.callbacks!.signIn!(signInArgs);
    expect(typeof result).toBe('string');
    if (typeof result !== 'string') throw new Error('Expected an SSO error redirect');
    const redirect = new URL(result, 'https://example.com');
    expect(redirect.pathname).toBe('/users/sign_in');
    expect(redirect.searchParams.get('error')).toBe('OAUTH_ERROR');
    expect(redirect.searchParams.get('callbackPath')).toBe(callbackPath);
  });

  test('does not forward the invitation or Watchwood context during account linking', async () => {
    jest.mocked(getAccountLinkingSession).mockResolvedValue({
      existingUserId: 'existing-user',
      targetProvider: 'workos',
      createdAt: Date.now(),
    });
    jest
      .mocked(userServer.getUserFromSession)
      .mockResolvedValue({ id: 'existing-user' } as Awaited<
        ReturnType<typeof userServer.getUserFromSession>
      >);

    await expect(authOptions.callbacks!.signIn!(signInArgs)).resolves.toBe(true);
    expect(processSSOUserLogin).toHaveBeenCalledTimes(1);
    expect(processSSOUserLogin).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'workos' }),
      requestHeaders,
      null,
      { watchwood: undefined },
      undefined
    );
    expect(readWatchwoodSignupAssessment).not.toHaveBeenCalled();
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
    // 32 random bytes, base64url, minted only on the sign-in trigger.
    expect(token.webSessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
