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
jest.mock('@/lib/constants', () => ({
  ...(jest.requireActual('@/lib/constants') as object),
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
jest.mock('@/lib/organizations/organization-sso-policy', () => ({
  resolveSsoAuthorityForDomain: jest.fn(),
}));
jest.mock('@/lib/organizations/verified-domain-membership', () => ({
  ensureVerifiedDomainOrganizationMembership: jest.fn(),
}));
jest.mock('@/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn(async () => ({ id: 'cus_test' })),
  deleteStripeCustomer: jest.fn(async () => {}),
}));

import jwt from 'jsonwebtoken';
import { authOptions } from '@/lib/user/server';
import { createOrUpdateUser, linkAccountToExistingUser } from '@/lib/user';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { getAccountLinkingSession } from '@/lib/account-linking-session';
import { resolveSsoAuthorityForDomain } from '@/lib/organizations/organization-sso-policy';
import { ensureVerifiedDomainOrganizationMembership } from '@/lib/organizations/verified-domain-membership';

const mockCreateOrUpdateUser = jest.mocked(createOrUpdateUser);
const mockLinkAccountToExistingUser = jest.mocked(linkAccountToExistingUser);
const mockGetAccountLinkingSession = jest.mocked(getAccountLinkingSession);
const mockResolveSsoAuthorityForDomain = jest.mocked(resolveSsoAuthorityForDomain);
const mockEnsureVerifiedDomainOrganizationMembership = jest.mocked(
  ensureVerifiedDomainOrganizationMembership
);

const signIn = authOptions.callbacks!.signIn!;

function setValidTurnstileCookie() {
  cookieStore.set('turnstile_jwt', {
    name: 'turnstile_jwt',
    value: jwt.sign({ guid: randomUUID(), ip: '203.0.113.7' }, NEXTAUTH_SECRET, {
      algorithm: 'HS256',
      expiresIn: '5m',
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
    mockResolveSsoAuthorityForDomain.mockReset().mockResolvedValue({
      status: 'not_required',
      domain: 'example.com',
    });
    mockEnsureVerifiedDomainOrganizationMembership.mockReset().mockResolvedValue({
      organizationId: 'verified-domain-org',
      membershipCreated: true,
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
    expect(mockEnsureVerifiedDomainOrganizationMembership).toHaveBeenCalledWith('settled-user');
    expect(mockCreateOrUpdateUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnsureVerifiedDomainOrganizationMembership.mock.invocationCallOrder[0]
    );
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
    expect(mockEnsureVerifiedDomainOrganizationMembership).toHaveBeenCalledWith('settled-user');
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
    expect(mockEnsureVerifiedDomainOrganizationMembership).toHaveBeenCalledWith('settled-user');
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
    expect(mockEnsureVerifiedDomainOrganizationMembership).toHaveBeenCalledWith('settled-user');
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
    expect(mockEnsureVerifiedDomainOrganizationMembership).toHaveBeenCalledWith('settled-user');
  });

  it('fails ordinary authentication when verified-domain admission fails', async () => {
    mockEnsureVerifiedDomainOrganizationMembership.mockRejectedValueOnce(
      new Error('verified-domain admission failed')
    );

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

    expect(result).toContain('error=UNKNOWN-ERROR');
    expect(mockEnsureVerifiedDomainOrganizationMembership).toHaveBeenCalledWith('settled-user');
  });

  it('checks the settled user block before verified-domain admission', async () => {
    mockCreateOrUpdateUser.mockResolvedValueOnce({
      success: true,
      user: { id: 'blocked-user', blocked_reason: 'blocked' },
      isNew: false,
    } as never);

    const result = await signIn({
      user: {
        id: 'email-blocked@example.com',
        email: 'blocked@example.com',
        name: 'blocked',
        image: '',
      },
      account: {
        provider: 'email',
        providerAccountId: 'blocked@example.com',
        type: 'credentials',
      },
      profile: undefined,
    } as never);

    expect(result).toContain('error=BLOCKED');
    expect(mockEnsureVerifiedDomainOrganizationMembership).not.toHaveBeenCalled();
  });

  it('preserves ordinary-auth SSO enforcement before verified-domain admission', async () => {
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
    expect(mockEnsureVerifiedDomainOrganizationMembership).not.toHaveBeenCalled();
  });

  it('does not run verified-domain admission during provider-account linking', async () => {
    mockGetAccountLinkingSession.mockResolvedValueOnce({
      existingUserId: 'existing-user',
      targetProvider: 'google',
    } as never);
    mockLinkAccountToExistingUser.mockResolvedValueOnce({
      success: true,
      user: { id: 'existing-user', blocked_reason: null },
    } as never);

    const result = await signIn({
      user: { id: 'x', email: 'link@example.com', name: 'Link User', image: '' },
      account: { provider: 'google', providerAccountId: 'link-google-id', type: 'oauth' },
      profile: { email_verified: true, email: 'link@example.com' },
    } as never);

    expect(result).toBe(true);
    expect(mockLinkAccountToExistingUser).toHaveBeenCalled();
    expect(mockEnsureVerifiedDomainOrganizationMembership).not.toHaveBeenCalled();
  });
});
