import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';

const cookieStore = new Map<string, { name: string; value: string }>();
jest.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => cookieStore.set(name, { name, value }),
    delete: (name: string) => cookieStore.delete(name),
    getAll: () => [...cookieStore.values()],
  }),
}));
jest.mock('@kilocode/web-shared/lib/constants', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/constants') as object),
  allow_fake_login: true,
}));
jest.mock('@/lib/user', () => ({
  ...(jest.requireActual('@/lib/user') as object),
  createOrUpdateUser: jest.fn(),
  linkAccountToExistingUser: jest.fn(),
}));
jest.mock('@/lib/account-linking-session', () => ({
  getAccountLinkingSession: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-sso-policy', () => ({
  resolveSsoAuthorityForDomain: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/organizations/organizations') as object),
  getUserOrgMemberships: jest.fn(),
  getOrganizationById: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn(async () => ({ id: 'cus_test' })),
  deleteStripeCustomer: jest.fn(async () => {}),
}));
jest.mock('@kilocode/web-shared/lib/auth/claude/feature-flag.server', () => ({
  isClaudePlatformOAuthEnabled: jest.fn(async () => true),
}));

import jwt from 'jsonwebtoken';
import { encode, type JWT } from 'next-auth/jwt';
import { authOptions } from '@/lib/user/next-auth-options';
import { createOrUpdateUser, getUserAuthProviders, linkAccountToExistingUser } from '@/lib/user';
import type * as UserModule from '@/lib/user';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getAccountLinkingSession } from '@/lib/account-linking-session';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import {
  getOrganizationById,
  getUserOrgMemberships,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';
import { CLAUDE_OIDC_ISSUER } from '@kilocode/web-shared/lib/auth/claude/config';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { user_auth_provider } from '@kilocode/db/schema';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';

const mockCreateOrUpdateUser = jest.mocked(createOrUpdateUser);
const mockLinkAccountToExistingUser = jest.mocked(linkAccountToExistingUser);
const mockGetAccountLinkingSession = jest.mocked(getAccountLinkingSession);
const mockResolveSsoAuthorityForDomain = jest.mocked(resolveSsoAuthorityForDomain);
const mockGetUserOrgMemberships = jest.mocked(getUserOrgMemberships);
const mockGetOrganizationById = jest.mocked(getOrganizationById);

const signIn = authOptions.callbacks!.signIn!;

/** The organization a shared-services linking session targets. */
const SHARED_SERVICES_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000002';

function setValidTurnstileCookie() {
  cookieStore.set('turnstile_jwt', {
    name: 'turnstile_jwt',
    value: jwt.sign({ guid: randomUUID(), ip: '203.0.113.7' }, NEXTAUTH_SECRET, {
      algorithm: 'HS256',
      expiresIn: '5m',
    }),
  });
}

/** Signs in the request as `userId` with a real NextAuth session cookie. */
async function setSessionCookie(userId: string, claims: Partial<JWT> = {}) {
  cookieStore.set('next-auth.session-token', {
    name: 'next-auth.session-token',
    value: await encode({
      secret: NEXTAUTH_SECRET,
      token: { kiloUserId: userId, sub: randomUUID(), ...claims },
    }),
  });
}

describe('authOptions.callbacks.signIn auto-link wiring', () => {
  beforeEach(() => {
    cookieStore.clear();
    mockCreateOrUpdateUser.mockReset().mockResolvedValue({
      success: true,
      user: { id: 'settled-user', blocked_reason: null } as never,
      isNew: false,
    });
    mockLinkAccountToExistingUser.mockReset();
    mockGetAccountLinkingSession.mockReset().mockResolvedValue(null);
    mockGetUserOrgMemberships.mockReset();
    mockGetOrganizationById.mockReset();
    mockResolveSsoAuthorityForDomain.mockReset().mockResolvedValue({
      status: 'not_required',
      domain: 'example.com',
    });
  });

  it('passes autoLink=true for a Google profile that asserts email_verified', async () => {
    setValidTurnstileCookie();

    const result = await signIn({
      user: { id: 'x', email: 'cb-google@example.com', name: 'CB Google', image: '' },
      account: { provider: 'google', providerAccountId: 'cb-google-sub', type: 'oauth' },
      profile: { email_verified: true, email: 'cb-google@example.com' },
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(true);
  });

  it('passes autoLink=false for a GitHub profile without an email_verified claim', async () => {
    setValidTurnstileCookie();

    const result = await signIn({
      user: { id: 'x', email: 'cb-github@example.com', name: 'CB GitHub', image: '' },
      account: { provider: 'github', providerAccountId: 'cb-github-id', type: 'oauth' },
      profile: { login: 'cbgithub' },
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(false);
  });

  it('passes autoLink=true for a Discord profile with verified true', async () => {
    setValidTurnstileCookie();

    const result = await signIn({
      user: { id: 'x', email: 'cb-discord@example.com', name: 'CB Discord', image: '' },
      account: { provider: 'discord', providerAccountId: 'cb-discord-id', type: 'oauth' },
      profile: { verified: true },
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(true);
  });

  it('redirects to the pending link page on an eligible DIFFERENT-OAUTH', async () => {
    setValidTurnstileCookie();
    const owner = await insertTestUser({ google_user_email: 'cb-pending@example.com' });
    mockCreateOrUpdateUser.mockResolvedValueOnce({
      success: false,
      error: 'DIFFERENT-OAUTH',
      targetUserId: owner.id,
      accountHasVerifiedPrimaryAddress: true,
      providerAlreadyPresent: false,
    });

    const result = await signIn({
      user: { id: 'x', email: 'cb-pending@example.com', name: 'CB Pending', image: '' },
      account: { provider: 'github', providerAccountId: 'cb-pending-github', type: 'oauth' },
      profile: { login: 'cbpending' },
    } as never);

    expect(result).toBe('/users/pending-link');
    expect(cookieStore.get('pending-auth-link')?.value).toBeTruthy();
  });

  it('bounces an Apple account link without a session to pending completion', async () => {
    const owner = await insertTestUser({ google_user_email: 'cb-apple-link@example.com' });
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'apple',
      createdAt: Date.now(),
    });

    const result = await signIn({
      user: { id: 'x', email: 'cb-apple-link@example.com', name: 'CB Apple', image: '' },
      account: { provider: 'apple', providerAccountId: 'cb-apple-link-sub', type: 'oauth' },
      profile: { email_verified: 'true', email: 'cb-apple-link@example.com' },
    } as never);

    expect(result).toBe('/api/auth/pending-link/complete');
    expect(cookieStore.get('pending-auth-link')?.value).toBeTruthy();
    expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('refuses the Apple bounce when the target already has an Apple method', async () => {
    const owner = await insertTestUser({ google_user_email: 'cb-apple-dup@example.com' });
    await db.insert(user_auth_provider).values({
      kilo_user_id: owner.id,
      provider: 'apple',
      provider_account_id: 'cb-apple-existing-sub',
      email: 'cb-apple-dup@example.com',
      avatar_url: '',
    });
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'apple',
      createdAt: Date.now(),
    });

    const result = await signIn({
      user: { id: 'x', email: 'cb-apple-dup@example.com', name: 'CB Apple', image: '' },
      account: { provider: 'apple', providerAccountId: 'cb-apple-new-sub', type: 'oauth' },
      profile: { email_verified: 'true', email: 'cb-apple-dup@example.com' },
    } as never);

    expect(result).toBe('/connected-accounts?error=PROVIDER-ALREADY-LINKED');
    expect(cookieStore.get('pending-auth-link')).toBeUndefined();
  });

  it('refuses the Apple bounce when the Apple identity belongs to another user', async () => {
    const owner = await insertTestUser({ google_user_email: 'cb-apple-owner@example.com' });
    const other = await insertTestUser({ google_user_email: 'cb-apple-other@example.com' });
    await db.insert(user_auth_provider).values({
      kilo_user_id: other.id,
      provider: 'apple',
      provider_account_id: 'cb-apple-shared-sub',
      email: 'cb-apple-other@example.com',
      avatar_url: '',
    });
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'apple',
      createdAt: Date.now(),
    });

    const result = await signIn({
      user: { id: 'x', email: 'cb-apple-owner@example.com', name: 'CB Apple', image: '' },
      account: { provider: 'apple', providerAccountId: 'cb-apple-shared-sub', type: 'oauth' },
      profile: { email_verified: 'true', email: 'cb-apple-owner@example.com' },
    } as never);

    expect(result).toBe('/connected-accounts?error=ACCOUNT-ALREADY-LINKED');
    expect(cookieStore.get('pending-auth-link')).toBeUndefined();
  });

  it('passes autoLink=true for an email (magic link) sign-in', async () => {
    const result = await signIn({
      user: {
        id: 'email-cb-email@example.com',
        email: 'cb-email@example.com',
        name: 'cb-email',
        image: '',
      },
      account: {
        provider: 'email',
        providerAccountId: 'cb-email@example.com',
        type: 'credentials',
      },
      profile: undefined,
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(true);
  });

  it('passes autoLink=true for an Apple profile with the string "true" email_verified claim', async () => {
    setValidTurnstileCookie();

    const result = await signIn({
      user: { id: 'x', email: 'cb-apple@example.com', name: 'CB Apple', image: '' },
      account: { provider: 'apple', providerAccountId: 'cb-apple-sub', type: 'oauth' },
      profile: { email_verified: 'true', email: 'cb-apple@example.com' },
    } as never);

    expect(result).toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(true);
  });

  it('admits fake login after settlement without applying ordinary SSO discovery', async () => {
    const result = await signIn({
      user: {
        id: 'fake-cb-fake@example.com',
        email: 'cb-fake@example.com',
        name: 'cb-fake',
        image: 'data:image/svg+xml,test',
      },
      account: {
        provider: 'fake-login',
        providerAccountId: 'cb-fake@example.com',
        type: 'credentials',
      },
      profile: undefined,
    } as never);

    expect(result).toBe(true);
    expect(mockResolveSsoAuthorityForDomain).not.toHaveBeenCalled();
  });

  it('refuses a sign-in whose address has no domain before user settlement', async () => {
    const result = await signIn({
      user: { id: 'x', email: 'no-domain', name: 'No Domain', image: '' },
      account: { provider: 'google', providerAccountId: 'no-domain-sub', type: 'oauth' },
      profile: { email_verified: true, email: 'no-domain' },
    } as never);

    expect(result).toContain('/users/sign_in?error=USER-NOT-FOUND');
    expect(mockResolveSsoAuthorityForDomain).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('enforces ordinary-auth SSO before user settlement', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValueOnce({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: 'sso-org',
    });

    const result = await signIn({
      user: { id: 'x', email: 'sso-user@example.com', name: 'SSO User', image: '' },
      account: { provider: 'github', providerAccountId: 'sso-github-id', type: 'oauth' },
      profile: { login: 'ssouser' },
    } as never);

    expect(result).toContain('/users/sign_in?domain=example.com');
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('admits a passkey without Turnstile or user settlement, after the SSO-authority block', async () => {
    // No Turnstile cookie is set: the redeemed ticket is the identity proof.
    const result = await signIn({
      user: { id: 'passkey-user', email: 'passkey@example.com', name: 'Passkey User', image: '' },
      account: { provider: 'passkey', providerAccountId: 'passkey-user', type: 'credentials' },
      profile: undefined,
    } as never);

    expect(result).toBe(true);
    expect(cookieStore.has('turnstile_jwt')).toBe(false);
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('still enforces SSO for a passkey sign-in on an SSO-protected domain', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValueOnce({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: 'sso-org',
    });

    const result = await signIn({
      user: { id: 'passkey-user', email: 'passkey@example.com', name: 'Passkey User', image: '' },
      account: { provider: 'passkey', providerAccountId: 'passkey-user', type: 'credentials' },
      profile: undefined,
    } as never);

    expect(result).toContain('/users/sign_in?domain=example.com');
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('skips ordinary SSO enforcement during provider-account linking', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValueOnce({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: 'sso-org',
    });
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: 'existing-user',
      targetProvider: 'openai',
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({
      success: true,
      user: { id: 'existing-user', blocked_reason: null },
    } as never);
    await setSessionCookie('existing-user');

    const result = await signIn({
      user: { id: 'x', email: 'sso-link@example.com', name: 'SSO Link', image: '' },
      account: {
        provider: 'openai',
        providerAccountId: 'openai-account',
        type: 'oauth',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.obo',
      },
      profile: { sub: 'openai-sub', email: 'sso-link@example.com' },
    } as never);

    expect(result).toBe(true);
    expect(mockResolveSsoAuthorityForDomain).not.toHaveBeenCalled();
    expect(mockLinkAccountToExistingUser).toHaveBeenCalled();
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('requires the web session to name the same user as the pending link', async () => {
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: 'existing-user',
      targetProvider: 'openai',
    } as never);
    await setSessionCookie('other-user');

    const result = await signIn({
      user: { id: 'x', email: 'mismatch-link@example.com', name: 'Mismatch', image: '' },
      account: {
        provider: 'openai',
        providerAccountId: 'openai-account',
        type: 'oauth',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.obo',
      },
      profile: { sub: 'openai-mismatch-sub', email: 'mismatch-link@example.com' },
    } as never);

    // The refusal is the linking failure the person reads on the page the link
    // started from, and no user is settled and no provider is attached.
    expect(result).toBe('/connected-accounts?error=LINKING-FAILED');
    expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('requires a web session to complete a pending link', async () => {
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: 'existing-user',
      targetProvider: 'openai',
    } as never);

    const result = await signIn({
      user: { id: 'x', email: 'anonymous-link@example.com', name: 'Anonymous', image: '' },
      account: {
        provider: 'openai',
        providerAccountId: 'openai-account',
        type: 'oauth',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.obo',
      },
      profile: { sub: 'openai-anonymous-sub', email: 'anonymous-link@example.com' },
    } as never);

    expect(result).toBe('/connected-accounts?error=LINKING-FAILED');
    expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('sends a refused organization connect back to its BYOK card', async () => {
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: 'existing-user',
      targetProvider: 'openai',
      organizationId: SHARED_SERVICES_ORGANIZATION_ID,
      chatGptScope: 'shared_services',
    } as never);
    await setSessionCookie('other-user');

    const result = await signIn({
      user: { id: 'x', email: 'org-mismatch@example.com', name: 'Org Mismatch', image: '' },
      account: {
        provider: 'openai',
        providerAccountId: 'openai-account',
        type: 'oauth',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.obo',
      },
      profile: { sub: 'openai-org-mismatch-sub', email: 'org-mismatch@example.com' },
    } as never);

    // The organization's BYOK card reads `openai_error`, so a refused
    // organization connect returns there, like the shared-services re-check.
    expect(result).toBe(
      `/organizations/${SHARED_SERVICES_ORGANIZATION_ID}/byok?openai_error=LINKING-FAILED`
    );
    expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
  });

  it('carries the linking session organization onto the profile for an OpenAI connection', async () => {
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: 'existing-user',
      targetProvider: 'openai',
      organizationId: '00000000-0000-4000-8000-000000000001',
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({
      success: true,
      user: { id: 'existing-user', blocked_reason: null },
    } as never);
    await setSessionCookie('existing-user');

    const profile: Record<string, unknown> = {
      sub: 'openai-org-sub',
      email: 'org-link@example.com',
    };

    const result = await signIn({
      user: { id: 'x', email: 'org-link@example.com', name: 'Org Link', image: '' },
      account: {
        provider: 'openai',
        providerAccountId: 'openai-account',
        type: 'oauth',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.obo',
      },
      profile,
    } as never);

    expect(result).toBe(true);
    expect(profile.openAiChatGptOrganizationId).toBe('00000000-0000-4000-8000-000000000001');
  });

  // The link start authorized the connect, but the OpenAI consent round-trip
  // can outlive that role, so the callback re-reads the current membership
  // before the jwt callback stores the organization's shared-services
  // connection.
  async function openAiSharedServicesSignIn() {
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: 'existing-user',
      targetProvider: 'openai',
      organizationId: SHARED_SERVICES_ORGANIZATION_ID,
      chatGptScope: 'shared_services',
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({
      success: true,
      user: { id: 'existing-user', blocked_reason: null },
    } as never);
    await setSessionCookie('existing-user');

    return signIn({
      user: { id: 'x', email: 'shared-services@example.com', name: 'Shared', image: '' },
      account: {
        provider: 'openai',
        providerAccountId: 'openai-account',
        type: 'oauth',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.obo',
      },
      profile: { sub: 'openai-shared-services-sub', email: 'shared-services@example.com' },
    } as never);
  }

  it('refuses the shared-services connect when the connector role was revoked', async () => {
    mockGetUserOrgMemberships.mockResolvedValueOnce([
      { orgId: SHARED_SERVICES_ORGANIZATION_ID, role: 'member' },
    ]);
    mockGetOrganizationById.mockResolvedValueOnce({ parent_organization_id: null } as never);

    const result = await openAiSharedServicesSignIn();

    // NextAuth stops before the jwt callback when the `signIn` callback returns
    // a redirect string, so the refused connect writes no connection row. The
    // redirect is the organization BYOK page, whose card renders the code.
    expect(result).toBe(
      `/organizations/${SHARED_SERVICES_ORGANIZATION_ID}/byok?openai_error=LINKING-FAILED`
    );
  });

  it('admits the shared-services connect while the connector still manages the organization', async () => {
    mockGetUserOrgMemberships.mockResolvedValueOnce([
      { orgId: SHARED_SERVICES_ORGANIZATION_ID, role: 'admin' },
    ]);
    mockGetOrganizationById.mockResolvedValueOnce({ parent_organization_id: null } as never);

    await expect(openAiSharedServicesSignIn()).resolves.toBe(true);
  });

  it('admits the shared-services connect for a manager of the parent organization', async () => {
    // The link start grants this through the organization-access helper, which
    // inherits parent-organization management roles, so the callback must not
    // refuse a connect the start admitted.
    mockGetUserOrgMemberships.mockResolvedValueOnce([
      { orgId: '00000000-0000-4000-8000-000000000003', role: 'owner' },
    ]);
    mockGetOrganizationById.mockResolvedValueOnce({
      parent_organization_id: '00000000-0000-4000-8000-000000000003',
    } as never);

    await expect(openAiSharedServicesSignIn()).resolves.toBe(true);
  });
});

describe('authOptions.callbacks.signIn for Claude', () => {
  const claudeSignIn = (profile: Record<string, unknown>) =>
    signIn({
      user: { id: 'x', email: 'claude-cb@example.com', name: 'Claude CB', image: '' },
      account: { provider: 'claude', providerAccountId: 'pairwise-sub', type: 'oauth' },
      profile: { sub: 'pairwise-sub', email: 'claude-cb@example.com', ...profile },
    } as never);

  beforeEach(() => {
    cookieStore.clear();
    mockCreateOrUpdateUser.mockReset().mockResolvedValue({
      success: true,
      user: { id: 'settled-user', blocked_reason: null } as never,
      isNew: false,
    });
    mockLinkAccountToExistingUser.mockReset();
    mockGetAccountLinkingSession.mockReset().mockResolvedValue(null);
    jest.mocked(isClaudePlatformOAuthEnabled).mockClear().mockResolvedValue(true);
    mockResolveSsoAuthorityForDomain.mockReset().mockResolvedValue({
      status: 'not_required',
      domain: 'example.com',
    });
  });

  it('refuses a Claude sign-in before settlement while it is not launched', async () => {
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValueOnce(false);
    setValidTurnstileCookie();

    const result = await claudeSignIn({});

    expect(result).toEqual(expect.stringContaining('error=UNKNOWN-ERROR'));
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('settles an issuer-qualified Claude account from a token without email_verified', async () => {
    setValidTurnstileCookie();
    await expect(claudeSignIn({})).resolves.toBe(true);
    expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith('claude-cb@example.com');
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[0]).toMatchObject({
      provider: 'claude',
      provider_account_id: `${CLAUDE_OIDC_ISSUER}#pairwise-sub`,
      hosted_domain: '@@claude@@',
    });
    // Without a verified-email claim the sign-in must not attach to an account
    // that already owns this email.
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(false);
  });

  it('lets a verified-email claim auto-link, like every other provider', async () => {
    setValidTurnstileCookie();
    await expect(claudeSignIn({ email_verified: true })).resolves.toBe(true);
    expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(true);
  });

  it('reports rejected claim names without identity or credential values', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await claudeSignIn({
        access_token: 'private-access-value',
        id_token: 'private-id-value',
        private_claim: 'private-claim-value',
        email: undefined,
      });
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        reason: 'invalid_profile_claims',
        rejectedClaims: ['email'],
      });
      const diagnostic = JSON.stringify(warn.mock.calls);
      for (const value of [
        'claude-cb@example.com',
        'pairwise-sub',
        'private-access-value',
        'private-id-value',
        'private-claim-value',
        'private_claim',
      ]) {
        expect(diagnostic).not.toContain(value);
      }
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
      expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    { email: undefined },
    { email: null },
    { email: 'not-an-email' },
    { email: 'different@kilocode.ai' },
    { email_verified: false },
  ])(
    'refuses a missing, unverified, or mismatched Claude email before flag evaluation: %s',
    async profile => {
      setValidTurnstileCookie();
      await expect(claudeSignIn(profile)).resolves.toEqual(
        expect.stringContaining('error=UNKNOWN-ERROR')
      );
      expect(isClaudePlatformOAuthEnabled).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    }
  );
});

describe('Claude explicit linking persistence', () => {
  beforeEach(() => {
    cookieStore.clear();
    mockCreateOrUpdateUser.mockReset();
    mockLinkAccountToExistingUser
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof UserModule>('@/lib/user').linkAccountToExistingUser
      );
    mockGetAccountLinkingSession.mockReset().mockResolvedValue(null);
    jest.mocked(isClaudePlatformOAuthEnabled).mockReset().mockResolvedValue(true);
    mockResolveSsoAuthorityForDomain.mockReset().mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: SHARED_SERVICES_ORGANIZATION_ID,
    });
  });

  async function prepareLink(subject = `explicit-${randomUUID()}`) {
    const owner = await insertTestUser({
      google_user_email: `authenticated-link-${randomUUID()}@example.com`,
      web_session_pepper: randomUUID(),
    });
    async function start() {
      await setSessionCookie(owner.id, {
        authProvider: 'workos',
        webSessionPepper: owner.web_session_pepper,
        ssoSourceOrganizationId: SHARED_SERVICES_ORGANIZATION_ID,
      });
      mockGetAccountLinkingSession.mockResolvedValueOnce({
        existingUserId: owner.id,
        targetProvider: 'claude',
        createdAt: Date.now(),
      });
    }
    await start();
    return {
      owner,
      start,
      complete: () =>
        signIn({
          user: { id: subject, email: 'external-link@example.net', name: 'External' },
          account: { provider: 'claude', providerAccountId: subject, type: 'oauth' },
          profile: { sub: subject, email: 'external-link@example.net' },
        }),
      providers: async () =>
        (await getUserAuthProviders(owner.id)).filter(provider => provider.provider === 'claude'),
      subject,
    };
  }

  it('attaches a claim-omitting subject to the authenticated SSO owner', async () => {
    const link = await prepareLink();
    jest
      .mocked(isClaudePlatformOAuthEnabled)
      .mockImplementation(async email => email === link.owner.google_user_email);

    await expect(link.complete()).resolves.toBe('/connected-accounts?linked=claude');
    expect(await link.providers()).toEqual([
      expect.objectContaining({
        kilo_user_id: link.owner.id,
        provider_account_id: `${CLAUDE_OIDC_ISSUER}#${link.subject}`,
      }),
    ]);
    expect((await findUserById(link.owner.id))?.google_user_email).toBe(
      link.owner.google_user_email
    );
  });

  it.each(['absent', 'revoked', 'different'])(
    'refuses attachment with an %s initiating session',
    async sessionState => {
      const link = await prepareLink();
      if (sessionState === 'absent') {
        cookieStore.clear();
      } else {
        const sessionUser = sessionState === 'different' ? await insertTestUser() : link.owner;
        await setSessionCookie(sessionUser.id, {
          webSessionPepper:
            sessionState === 'revoked' ? randomUUID() : sessionUser.web_session_pepper,
        });
      }
      await expect(link.complete()).resolves.toEqual(
        expect.stringContaining('error=LINKING-FAILED')
      );
      expect(await link.providers()).toEqual([]);
    }
  );

  it('refuses attachment when the initiating account loses release eligibility', async () => {
    const link = await prepareLink();
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    await expect(link.complete()).resolves.toEqual(expect.stringContaining('error=LINKING-FAILED'));
    expect(await link.providers()).toEqual([]);
  });

  it.each(['absent', 'different'])(
    'treats an %s link intent as a plain sign-in that cannot attach the subject',
    async intentState => {
      const link = await prepareLink();
      // The sign-in email already belongs to another Kilo account, so a plain
      // sign-in for it must be refused instead of attaching the Claude subject.
      const email = `external-${randomUUID()}@example.net`;
      await insertTestUser({ google_user_email: email });
      setValidTurnstileCookie();
      mockResolveSsoAuthorityForDomain.mockResolvedValue({
        status: 'not_required',
        domain: 'example.net',
      });
      mockGetAccountLinkingSession
        .mockReset()
        .mockResolvedValue(
          intentState === 'different'
            ? { existingUserId: link.owner.id, targetProvider: 'google', createdAt: Date.now() }
            : null
        );
      // Settlement finds the existing account that owns this email and another
      // provider's subject.
      mockCreateOrUpdateUser.mockResolvedValue({
        success: false,
        error: 'DIFFERENT-OAUTH',
        targetUserId: link.owner.id,
        accountHasVerifiedPrimaryAddress: false,
        providerAlreadyPresent: true,
      });
      const result = await signIn({
        user: { id: link.subject, email, name: 'External' },
        account: { provider: 'claude', providerAccountId: link.subject, type: 'oauth' },
        profile: { sub: link.subject, email },
      } as never);
      expect(result).toEqual(expect.stringContaining('error=DIFFERENT-OAUTH'));
      // A plain sign-in reaches settlement for its own email without the
      // auto-link step, so it cannot attach the subject to another account.
      expect(mockCreateOrUpdateUser).toHaveBeenCalledTimes(1);
      expect(mockCreateOrUpdateUser.mock.calls[0]?.[0]).toMatchObject({
        google_user_email: email,
        provider_account_id: `${CLAUDE_OIDC_ISSUER}#${link.subject}`,
      });
      expect(mockCreateOrUpdateUser.mock.calls[0]?.[2]).toBe(false);
      expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
      expect(await link.providers()).toEqual([]);
    }
  );

  it('does not move a subject already attached to another account', async () => {
    const original = await prepareLink();
    await original.complete();
    const attempted = await prepareLink(original.subject);
    await expect(attempted.complete()).resolves.toEqual(
      expect.stringContaining('error=ACCOUNT-ALREADY-LINKED')
    );
    expect(await attempted.providers()).toEqual([]);
    expect(await original.providers()).toEqual([
      expect.objectContaining({ kilo_user_id: original.owner.id }),
    ]);
  });

  it('does not replace an existing Claude subject', async () => {
    const original = await prepareLink();
    await original.complete();
    const attempted = await prepareLink();
    mockGetAccountLinkingSession.mockReset().mockResolvedValueOnce({
      existingUserId: original.owner.id,
      targetProvider: 'claude',
      createdAt: Date.now(),
    });
    await original.start();
    await expect(attempted.complete()).resolves.toEqual(
      expect.stringContaining('error=PROVIDER-ALREADY-LINKED')
    );
    expect(await original.providers()).toEqual([
      expect.objectContaining({
        provider_account_id: `${CLAUDE_OIDC_ISSUER}#${original.subject}`,
      }),
    ]);
    expect(await attempted.providers()).toEqual([]);
  });

  it('permits a new link attempt for the same owner and subject', async () => {
    const link = await prepareLink();
    await link.complete();
    await link.start();
    await expect(link.complete()).resolves.toBe('/connected-accounts?linked=claude');
    expect(await link.providers()).toEqual([
      expect.objectContaining({
        kilo_user_id: link.owner.id,
        provider_account_id: `${CLAUDE_OIDC_ISSUER}#${link.subject}`,
      }),
    ]);
  });
});
