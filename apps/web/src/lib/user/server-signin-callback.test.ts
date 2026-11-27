import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createHash, randomUUID } from 'crypto';
import { setImmediate as nextMacrotask } from 'node:timers/promises';

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
  ...(jest.requireActual('@/lib/account-linking-session') as object),
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
// A completed ChatGPT link stores the delegated credential; the eligibility
// probe would call OpenAI.
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/eligibility', () => ({
  ...(jest.requireActual(
    '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/eligibility'
  ) as object),
  probeOpenAiChatGptEligibility: jest.fn(async () => true),
}));
import jwt from 'jsonwebtoken';
import { encode, type JWT } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { authOptions, nextAuthHttpHandler } from '@/lib/user/next-auth-options';
import { createOrUpdateUser, getUserAuthProviders, linkAccountToExistingUser } from '@/lib/user';
import type * as UserModule from '@/lib/user';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getAccountLinkingSession } from '@/lib/account-linking-session';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import {
  getOrganizationById,
  getUserOrgMemberships,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { CLAUDE_OIDC_ISSUER } from '@kilocode/web-shared/lib/auth/claude/config';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { auth_audit_logs, user_auth_provider, type User } from '@kilocode/db/schema';
import { createDeletionInProgressBlockedReason } from '@kilocode/db/user-soft-delete';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import { eq } from 'drizzle-orm';
import {
  authAuditEmailHash,
  setAuthActionSinkForTest,
  type AuthActionEvent,
} from '@/lib/auth/auth-audit';

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

/** A real account whose live web session starts a link. */
async function insertLinkOwner() {
  return insertTestUser({
    google_user_email: `link-owner-${randomUUID()}@example.com`,
    web_session_pepper: randomUUID(),
  });
}

/** The browser session that starts the link in these suites. */
const OWNER_WEB_SESSION_ID = 'web-session-link-owner';
const OWNER_WEB_SESSION_ID_HASH = hashWebSessionId(OWNER_WEB_SESSION_ID);

async function setOwnerSessionCookie(owner: User, claims: Partial<JWT> = {}) {
  await setSessionCookie(owner.id, {
    webSessionPepper: owner.web_session_pepper,
    webSessionId: OWNER_WEB_SESSION_ID,
    ...claims,
  });
}

/** An organization whose SSO policy the mocked domain authority names. */
async function insertSsoOrganization(ownerId: string, allowNonSsoSignInMethods: boolean) {
  return createTestOrganization('SSO policy org', ownerId, 0, {
    allow_non_sso_sign_in_methods: allowNonSsoSignInMethods,
  });
}

type SignInParams = Parameters<typeof signIn>[0];

/** The callback of a ChatGPT authorization that completes a link. */
function openAiLinkCallback(email: string, subject: string): SignInParams {
  return {
    user: { id: 'x', email, name: 'Link', image: '' },
    account: {
      provider: 'openai',
      providerAccountId: subject,
      type: 'oauth',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.obo',
    },
    profile: { sub: subject, email },
  } as unknown as SignInParams;
}

// These suites exercise a request the way a local run serves it: the client
// address arrives in the forwarded header, and no platform label rewrites it.
const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});
afterEach(() => {
  process.env = originalEnv;
});

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

  it('refuses a provider profile that shares no email address', async () => {
    setValidTurnstileCookie();

    const result = await signIn({
      user: { id: 'x', email: null, name: 'CB Discord', image: '' },
      account: { provider: 'discord', providerAccountId: 'cb-discord-no-email', type: 'oauth' },
      profile: { verified: true },
    } as never);

    expect(result).toBe('/users/sign_in?error=EMAIL-REQUIRED');
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
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
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
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
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
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
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
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

  it('refuses a passkey sign-in for an account whose deletion is in progress', async () => {
    // The shape `disableUserAccessForDeletion` writes.
    const deletingUser = await insertTestUser({
      blocked_reason: createDeletionInProgressBlockedReason(),
      blocked_at: new Date().toISOString(),
    });

    const result = await signIn({
      user: {
        id: deletingUser.id,
        email: deletingUser.google_user_email,
        name: deletingUser.google_user_name,
        image: '',
      },
      account: {
        provider: 'passkey',
        providerAccountId: deletingUser.id,
        type: 'credentials',
      },
      profile: undefined,
    } as never);

    expect(result).toContain('/users/sign_in?error=BLOCKED');
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('refuses a link for an SSO domain whose organization does not allow other methods', async () => {
    const owner = await insertLinkOwner();
    const organization = await insertSsoOrganization(owner.id, false);
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: organization.id,
    });
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'openai',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
    } as never);
    await setOwnerSessionCookie(owner);

    const result = await signIn(openAiLinkCallback('sso-link@example.net', 'openai-sso-sub'));

    expect(result).toBe('/connected-accounts?error=SIGN-IN-METHOD-SSO-REQUIRED');
    expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('links for an SSO domain whose organization allows other methods, without a new session', async () => {
    const owner = await insertLinkOwner();
    const organization = await insertSsoOrganization(owner.id, true);
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: organization.id,
    });
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'openai',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({ success: true, user: owner } as never);
    await setOwnerSessionCookie(owner);

    const result = await signIn(openAiLinkCallback('sso-link@example.net', 'openai-sso-ok-sub'));

    // A redirect, not `true`: NextAuth issues no session token for the link.
    expect(result).toBe('/connected-accounts?linked=openai');
    expect(mockLinkAccountToExistingUser).toHaveBeenCalled();
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('refuses a link that another browser session of the same user finishes', async () => {
    const owner = await insertLinkOwner();
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'openai',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
      createdAt: Date.now(),
    });
    await setOwnerSessionCookie(owner, { webSessionId: 'web-session-other-browser' });

    const result = await signIn(openAiLinkCallback('other-session@example.net', 'openai-other'));

    expect(result).toBe('/connected-accounts?error=LINKING-FAILED');
    expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('refuses a link from a session that has no browser session id', async () => {
    const owner = await insertLinkOwner();
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'openai',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
      createdAt: Date.now(),
    });
    await setSessionCookie(owner.id, { webSessionPepper: owner.web_session_pepper });

    const result = await signIn(openAiLinkCallback('no-session-id@example.net', 'openai-no-id'));

    expect(result).toBe('/connected-accounts?error=LINKING-FAILED');
    expect(mockLinkAccountToExistingUser).not.toHaveBeenCalled();
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

  it('carries the linking session organization onto the profile and returns to its BYOK page', async () => {
    const owner = await insertLinkOwner();
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'openai',
      organizationId: '00000000-0000-4000-8000-000000000001',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({ success: true, user: owner } as never);
    await setOwnerSessionCookie(owner);
    // The connect started from the organization's BYOK card, which NextAuth
    // keeps as the callback URL.
    cookieStore.set('next-auth.callback-url', {
      name: 'next-auth.callback-url',
      value: 'http://localhost:3000/organizations/00000000-0000-4000-8000-000000000001/byok',
    });

    const profile: Record<string, unknown> = {
      sub: 'openai-org-sub',
      email: 'org-link@example.com',
    };

    const result = await signIn({
      ...openAiLinkCallback('org-link@example.com', 'openai-org-sub'),
      profile,
    } as never);

    expect(result).toBe('/organizations/00000000-0000-4000-8000-000000000001/byok');
    expect(profile.openAiChatGptOrganizationId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('never redirects a completed link off the site', async () => {
    const owner = await insertLinkOwner();
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'openai',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({ success: true, user: owner } as never);
    await setOwnerSessionCookie(owner);
    cookieStore.set('next-auth.callback-url', {
      name: 'next-auth.callback-url',
      value: 'https://attacker.example/steal?x=1',
    });

    await expect(
      signIn(openAiLinkCallback('offsite-link@example.com', 'openai-offsite-sub'))
    ).resolves.toBe('/steal?x=1');
  });

  // The link start authorized the connect, but the OpenAI consent round-trip
  // can outlive that role, so the callback re-reads the current membership
  // before it stores the organization's shared-services connection.
  async function openAiSharedServicesSignIn() {
    const owner = await insertLinkOwner();
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'openai',
      organizationId: SHARED_SERVICES_ORGANIZATION_ID,
      chatGptScope: 'shared_services',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({ success: true, user: owner } as never);
    await setOwnerSessionCookie(owner);

    return signIn(
      openAiLinkCallback('shared-services@example.com', 'openai-shared-services-sub') as never
    );
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

    await expect(openAiSharedServicesSignIn()).resolves.toBe('/connected-accounts?linked=openai');
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

    await expect(openAiSharedServicesSignIn()).resolves.toBe('/connected-accounts?linked=openai');
  });

  it('refuses the shared-services connect for a platform admin without a managing membership', async () => {
    const admin = await insertTestUser({
      google_user_email: `link-admin-${randomUUID()}@example.com`,
      web_session_pepper: randomUUID(),
      is_admin: true,
    });
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: admin.id,
      targetProvider: 'openai',
      organizationId: SHARED_SERVICES_ORGANIZATION_ID,
      chatGptScope: 'shared_services',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({ success: true, user: admin } as never);
    mockGetUserOrgMemberships.mockResolvedValueOnce([]);
    mockGetOrganizationById.mockResolvedValueOnce({ parent_organization_id: null } as never);
    await setOwnerSessionCookie(admin);

    await expect(
      signIn(openAiLinkCallback('shared-admin@example.com', 'openai-shared-admin-sub') as never)
    ).resolves.toBe(
      `/organizations/${SHARED_SERVICES_ORGANIZATION_ID}/byok?openai_error=LINKING-FAILED`
    );
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
    mockResolveSsoAuthorityForDomain.mockReset().mockResolvedValue({
      status: 'not_required',
      domain: 'example.com',
    });
  });

  it('settles an issuer-qualified Claude account from a token without email_verified', async () => {
    setValidTurnstileCookie();
    await expect(claudeSignIn({})).resolves.toBe(true);
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
  ])('refuses a missing, unverified, or mismatched Claude email: %s', async profile => {
    setValidTurnstileCookie();
    await expect(claudeSignIn(profile)).resolves.toEqual(
      expect.stringContaining('error=UNKNOWN-ERROR')
    );
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });
});

describe('Claude explicit linking persistence', () => {
  // The owners' domain requires SSO, and its organization allows linking
  // other sign-in methods.
  let ssoOrganizationId: string;

  beforeEach(async () => {
    cookieStore.clear();
    mockCreateOrUpdateUser.mockReset();
    mockLinkAccountToExistingUser
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof UserModule>('@/lib/user').linkAccountToExistingUser
      );
    mockGetAccountLinkingSession.mockReset().mockResolvedValue(null);
    ssoOrganizationId = (await insertSsoOrganization((await insertTestUser()).id, true)).id;
    mockResolveSsoAuthorityForDomain.mockReset().mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: ssoOrganizationId,
    });
  });

  async function prepareLink(subject = `explicit-${randomUUID()}`) {
    const owner = await insertTestUser({
      google_user_email: `authenticated-link-${randomUUID()}@example.com`,
      web_session_pepper: randomUUID(),
    });
    async function start() {
      await setSessionCookie(owner.id, {
        webSessionId: OWNER_WEB_SESSION_ID,
        authProvider: 'workos',
        webSessionPepper: owner.web_session_pepper,
        ssoSourceOrganizationId: ssoOrganizationId,
      });
      mockGetAccountLinkingSession.mockResolvedValueOnce({
        existingUserId: owner.id,
        targetProvider: 'claude',
        webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
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
          webSessionId: OWNER_WEB_SESSION_ID,
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
      mockGetAccountLinkingSession.mockReset().mockResolvedValue(
        intentState === 'different'
          ? {
              existingUserId: link.owner.id,
              targetProvider: 'google',
              webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
              createdAt: Date.now(),
            }
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
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
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

// The whole NextAuth callback, through the app's route handler: a link must
// leave the browser on the session it already has. A session that signed in
// long ago (a copied cookie) must not come back from a link with a new token,
// a new expiry, or a new sign-in time.
describe('the NextAuth callback for an account link', () => {
  const SESSION_COOKIE = 'next-auth.session-token';

  beforeEach(() => {
    cookieStore.clear();
    mockCreateOrUpdateUser.mockReset();
    mockLinkAccountToExistingUser.mockReset();
    mockGetAccountLinkingSession.mockReset().mockResolvedValue(null);
    mockResolveSsoAuthorityForDomain.mockReset().mockResolvedValue({
      status: 'not_required',
      domain: 'example.com',
    });
  });

  /** Posts the fake-login credentials callback with a valid CSRF pair. */
  async function postFakeLoginCallback(email: string): Promise<Response> {
    const csrfToken = randomUUID();
    const csrfHash = createHash('sha256').update(`${csrfToken}${NEXTAUTH_SECRET}`).digest('hex');
    cookieStore.set('next-auth.csrf-token', {
      name: 'next-auth.csrf-token',
      value: `${csrfToken}|${csrfHash}`,
    });
    const request = new NextRequest('http://localhost:3000/api/auth/callback/fake-login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, csrfToken }).toString(),
    });
    return nextAuthHttpHandler(request, {
      params: Promise.resolve({ nextauth: ['callback', 'fake-login'] }),
    });
  }

  function setsSessionCookie(response: Response): boolean {
    return response.headers.getSetCookie().some(cookie => cookie.startsWith(`${SESSION_COOKIE}=`));
  }

  it('issues a session for a plain sign-in, so the check below can see one', async () => {
    const email = `plain-${randomUUID()}@example.com`;
    const user = await insertTestUser({ google_user_email: email });
    await db.insert(user_auth_provider).values({
      kilo_user_id: user.id,
      provider: 'fake-login',
      provider_account_id: `fake-${email}`,
      email,
      avatar_url: '',
    });
    mockCreateOrUpdateUser.mockResolvedValueOnce({ success: true, user, isNew: false });

    const response = await postFakeLoginCallback(email);

    expect(setsSessionCookie(response)).toBe(true);
  });

  it('keeps the existing session when a link completes', async () => {
    const owner = await insertLinkOwner();
    const signedInLongAgo = Math.floor(Date.now() / 1000) - 20 * 24 * 60 * 60;
    await setOwnerSessionCookie(owner, { authenticatedAt: signedInLongAgo });
    const sessionBefore = cookieStore.get(SESSION_COOKIE)?.value;
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'fake-login',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
      createdAt: Date.now(),
    });
    mockLinkAccountToExistingUser.mockResolvedValueOnce({ success: true, user: owner } as never);

    const response = await postFakeLoginCallback(`linked-${randomUUID()}@example.net`);

    expect(mockLinkAccountToExistingUser).toHaveBeenCalledWith(
      owner.id,
      expect.objectContaining({ provider: 'fake-login' })
    );
    expect(setsSessionCookie(response)).toBe(false);
    expect(new URL(response.headers.get('location') ?? '', 'http://localhost:3000').pathname).toBe(
      '/connected-accounts'
    );
    expect(cookieStore.get(SESSION_COOKIE)?.value).toBe(sessionBefore);
  });
});

describe('sign-in audit rows', () => {
  let events: AuthActionEvent[];

  beforeEach(() => {
    cookieStore.clear();
    events = [];
    setAuthActionSinkForTest(event => events.push(event));
    mockCreateOrUpdateUser.mockReset().mockResolvedValue({
      success: true,
      user: { id: 'settled-user', blocked_reason: null } as never,
      isNew: false,
    });
    mockGetAccountLinkingSession.mockReset().mockResolvedValue(null);
    mockResolveSsoAuthorityForDomain.mockReset().mockResolvedValue({
      status: 'not_required',
      domain: 'example.com',
    });
  });

  afterEach(() => {
    setAuthActionSinkForTest(null);
  });

  async function rowsForEmail(email: string) {
    const hash = authAuditEmailHash(email);
    if (hash === null) throw new Error('the test environment has no email hash key');
    return db.select().from(auth_audit_logs).where(eq(auth_audit_logs.subject_email_hash, hash));
  }

  function googleSignIn(email: string) {
    return signIn({
      user: { id: 'x', email, name: 'Audit Google', image: '' },
      account: { provider: 'google', providerAccountId: `sub-${randomUUID()}`, type: 'oauth' },
      profile: { email_verified: true, email },
    } as never);
  }

  /** The jwt callback NextAuth runs after an accepted signIn: it issues the session. */
  function issueSession(callback: SignInParams) {
    return authOptions.callbacks!.jwt!({
      token: {},
      ...(callback as object),
      trigger: 'signIn',
      isNewUser: false,
      session: undefined,
    } as never);
  }

  it('records a sign-in once its session is issued, with the account and only a hash of the email', async () => {
    const { account, callback } = await insertAccountWithGoogleIdentity();
    mockCreateOrUpdateUser.mockResolvedValueOnce({
      success: true,
      user: account,
      isNew: false,
    } as never);
    setValidTurnstileCookie();

    await expect(signIn(callback)).resolves.toBe(true);
    // The signIn callback accepted; no session exists yet, so no row either.
    expect(await rowsForEmail(account.google_user_email)).toEqual([]);

    await issueSession(callback);

    const rows = await rowsForEmail(account.google_user_email);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in',
        outcome: 'success',
        user_id: account.id,
        method: 'google',
        failure_reason: null,
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in',
        outcome: 'success',
        userId: account.id,
        ip: '203.0.113.7',
      }),
    ]);
    expect(JSON.stringify({ rows, events })).not.toContain(account.google_user_email.split('@')[0]);
  });

  it('records a refusal that resolved no account under a hash of the presented address', async () => {
    const email = `audit-refused-${randomUUID()}@example.com`;

    const result = await googleSignIn(email);

    expect(result).toEqual(expect.stringContaining('TURNSTILE_REQUIRED'));
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    const rows = await rowsForEmail(email);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in',
        outcome: 'failure',
        user_id: null,
        method: 'google',
        failure_reason: 'turnstile_required',
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({ outcome: 'failure', failureReason: 'turnstile_required' }),
    ]);
    expect(JSON.stringify({ rows, events })).not.toContain(email.split('@')[0]);
  });

  it('records a magic link that authorize refuses as the log line only, since it names no account', async () => {
    // A Credentials provider keeps its configured id and authorize under
    // `options`; next-auth's provider type does not expose that authorize.
    const provider = authOptions.providers.find(
      candidate =>
        'options' in candidate &&
        typeof candidate.options === 'object' &&
        candidate.options !== null &&
        'id' in candidate.options &&
        candidate.options.id === 'email'
    ) as unknown as {
      options: { authorize: (credentials: { token: string }) => Promise<unknown> };
    };

    await expect(
      provider.options.authorize({ token: `unknown-${randomUUID()}` })
    ).resolves.toBeNull();

    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in',
        outcome: 'failure',
        method: 'email',
        failureReason: 'invalid_token',
        stored: false,
        persisted: false,
      }),
    ]);
  });

  it("records a refused link under the linked account's email, not the provider identity's", async () => {
    const owner = await insertLinkOwner();
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: owner.id,
      targetProvider: 'openai',
      webSessionIdHash: OWNER_WEB_SESSION_ID_HASH,
      createdAt: Date.now(),
    });
    await setOwnerSessionCookie(owner, { webSessionId: 'web-session-other-browser' });
    const providerEmail = `provider-identity-${randomUUID()}@example.net`;

    const result = await signIn(openAiLinkCallback(providerEmail, `openai-${randomUUID()}`));

    expect(result).toBe('/connected-accounts?error=LINKING-FAILED');
    expect(await rowsForEmail(providerEmail)).toEqual([]);
    expect(await rowsForEmail(owner.google_user_email)).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in_method.link',
        outcome: 'failure',
        user_id: owner.id,
        failure_reason: 'linking_failed',
      }),
    ]);
  });

  /** An account whose Google identity carries an address other than its primary one. */
  async function insertAccountWithGoogleIdentity() {
    const account = await insertTestUser({
      google_user_email: `primary-${randomUUID()}@example.com`,
    });
    const providerEmail = `google-identity-${randomUUID()}@example.com`;
    const sub = `sub-${randomUUID()}`;
    await db.insert(user_auth_provider).values({
      kilo_user_id: account.id,
      provider: 'google',
      provider_account_id: sub,
      email: providerEmail,
      avatar_url: '',
      hosted_domain: account.hosted_domain,
    });
    const callback = {
      user: { id: 'x', email: providerEmail, name: 'Audit Google', image: '' },
      account: { provider: 'google', providerAccountId: sub, type: 'oauth' },
      profile: { email_verified: true, email: providerEmail },
    } as never;
    return { account, providerEmail, callback };
  }

  it("hashes the account's primary email, not the provider's, once the sign-in resolves the account", async () => {
    const { account, providerEmail, callback } = await insertAccountWithGoogleIdentity();
    mockCreateOrUpdateUser.mockResolvedValueOnce({
      success: true,
      user: account,
      isNew: false,
    } as never);
    setValidTurnstileCookie();

    await expect(signIn(callback)).resolves.toBe(true);
    await issueSession(callback);

    expect(await rowsForEmail(providerEmail)).toEqual([]);
    expect(await rowsForEmail(account.google_user_email)).toEqual([
      expect.objectContaining({ action: 'auth.sign_in', outcome: 'success', user_id: account.id }),
    ]);
  });

  it("hashes the account's primary email on a refusal after the account is resolved", async () => {
    const { account, providerEmail, callback } = await insertAccountWithGoogleIdentity();

    // No Turnstile cookie: refused after the provider identity named the account.
    expect(await signIn(callback)).toEqual(expect.stringContaining('TURNSTILE_REQUIRED'));

    expect(await rowsForEmail(providerEmail)).toEqual([]);
    expect(await rowsForEmail(account.google_user_email)).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        user_id: account.id,
        failure_reason: 'turnstile_required',
      }),
    ]);
  });
});

describe('OAuth callback refusals before the signIn callback', () => {
  let events: AuthActionEvent[];

  beforeEach(() => {
    events = [];
    setAuthActionSinkForTest(event => events.push(event));
  });

  afterEach(() => {
    setAuthActionSinkForTest(null);
  });

  async function githubCallback(query: Record<string, string>): Promise<Response> {
    const url = new URL('http://localhost:3000/api/auth/callback/github');
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await nextAuthHttpHandler(new NextRequest(url), {
      params: Promise.resolve({ nextauth: ['callback', 'github'] }),
    });
    // The logger records the line without blocking NextAuth; let it finish.
    await nextMacrotask();
    return response;
  }

  it('logs a provider error by its code alone, without the error text', async () => {
    const response = await githubCallback({
      error: 'access_denied',
      error_description: 'The user denied the request',
    });

    expect(response.status).toBe(302);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in',
        outcome: 'failure',
        userId: null,
        method: 'github',
        failureReason: 'provider_error',
        stored: false,
        ip: '203.0.113.7',
      }),
    ]);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('access_denied');
    expect(logged).not.toContain('denied the request');
  });

  it('logs a callback whose state check fails', async () => {
    const response = await githubCallback({ code: 'provider-code', state: 'forged-state' });

    expect(response.status).toBe(302);
    expect(events).toEqual([
      expect.objectContaining({
        method: 'github',
        failureReason: 'oauth_callback_error',
        stored: false,
      }),
    ]);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('provider-code');
    expect(logged).not.toContain('forged-state');
  });
});
