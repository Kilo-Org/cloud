import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';

// The link and unlink procedures read the browser session from the request
// cookies, so the suite serves `next/headers` from a cookie jar it controls.
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

// Starting a link writes the linking cookie; the suite checks whether a link
// was started, not the cookie itself.
jest.mock('@/lib/account-linking-session', () => ({
  ...jest.requireActual('@/lib/account-linking-session'),
  createAccountLinkingSession: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/email', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/email'),
  sendNewSignInMethodEmail: jest.fn(async () => ({ sent: true })),
}));

import { encode, type JWT } from 'next-auth/jwt';
import { and, eq } from 'drizzle-orm';
import {
  admin_action_audit_logs,
  device_sessions,
  organization_audit_logs,
  organizations,
  passkey_credentials,
  session_step_up_proofs,
  user_auth_provider,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  createCallerForUser,
  createNativeCallerForUser,
  createSessionCallerForUser,
} from '@/routers/test-utils';
import { createAccountLinkingSession } from '@/lib/account-linking-session';
import { AccountLinkingProviders } from '@/lib/auth/provider-metadata';
import { linkAccountToExistingUser } from '@/lib/user';
import { SIGN_IN_METHOD_CHANGE_REFUSAL_CODES } from '@/lib/auth/sign-in-method-change-codes';

const mockCreateLinkingSession = jest.mocked(createAccountLinkingSession);

const nowSeconds = () => Math.floor(Date.now() / 1000);
/** A session that signed in long ago, such as a copied session cookie. */
const STALE_SIGN_IN = () => nowSeconds() - 20 * 24 * 60 * 60;

/** Puts a real NextAuth session cookie for `user` on the request. */
async function setSessionCookie(user: User, claims: Partial<JWT> = {}) {
  cookieStore.set('next-auth.session-token', {
    name: 'next-auth.session-token',
    value: await encode({
      secret: NEXTAUTH_SECRET,
      token: {
        kiloUserId: user.id,
        sub: randomUUID(),
        webSessionPepper: user.web_session_pepper,
        webSessionId: `web-session-${randomUUID()}`,
        ...claims,
      },
    }),
  });
}

async function insertUser(fields: Partial<User> = {}) {
  return insertTestUser({ web_session_pepper: randomUUID(), ...fields });
}

/** A user whose email domain an organization claims for SSO. */
async function insertSsoMember(fields: Partial<User> = {}) {
  const domain = `sso-${randomUUID().slice(0, 8)}.example.com`;
  const creator = await insertUser();
  const organization = await createTestOrganization('SSO org', creator.id, 0);
  await db
    .update(organizations)
    .set({ sso_domain: domain })
    .where(eq(organizations.id, organization.id));
  const member = await insertUser({ google_user_email: `member@${domain}`, ...fields });
  return { member, organization };
}

async function allowNonSsoSignInMethods(organizationId: string) {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  await db
    .update(organizations)
    .set({ settings: { ...organization?.settings, allow_non_sso_sign_in_methods: true } })
    .where(eq(organizations.id, organizationId));
}

async function addProvider(userId: string, provider: 'github' | 'google') {
  await db.insert(user_auth_provider).values({
    kilo_user_id: userId,
    provider,
    provider_account_id: `${provider}-${randomUUID()}`,
    email: `${provider}-${randomUUID()}@example.net`,
    avatar_url: '',
  });
}

async function providersOf(userId: string) {
  const rows = await db
    .select({ provider: user_auth_provider.provider })
    .from(user_auth_provider)
    .where(eq(user_auth_provider.kilo_user_id, userId));
  return rows.map(row => row.provider).sort();
}

function refusedWith(code: string) {
  return expect.objectContaining({
    code: 'FORBIDDEN',
    cause: expect.objectContaining({ upstreamCode: code }),
  });
}

beforeEach(() => {
  cookieStore.clear();
  mockCreateLinkingSession.mockReset();
});

describe('user.linkAuthProvider', () => {
  it('refuses an API token, even when the request also carries a fresh browser session', async () => {
    const user = await insertUser();
    await setSessionCookie(user, { authenticatedAt: nowSeconds() });
    const caller = await createCallerForUser(user.id);

    await expect(caller.user.linkAuthProvider({ provider: 'openai' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.browserSessionRequired)
    );
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('refuses a native app session', async () => {
    const user = await insertUser();
    const [deviceSession] = await db
      .insert(device_sessions)
      .values({ kilo_user_id: user.id })
      .returning({ id: device_sessions.id });
    const caller = await createNativeCallerForUser(user.id, deviceSession.id);

    await expect(caller.user.linkAuthProvider({ provider: 'github' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.browserSessionRequired)
    );
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('refuses a browser session that signed in long ago', async () => {
    const user = await insertUser();
    await setSessionCookie(user, { authenticatedAt: STALE_SIGN_IN() });
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.user.linkAuthProvider({ provider: 'openai' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.reauthRequired)
    );
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('refuses a browser session whose cookie names another account', async () => {
    const user = await insertUser();
    const other = await insertUser();
    await setSessionCookie(other, { authenticatedAt: nowSeconds() });
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.user.linkAuthProvider({ provider: 'openai' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.browserSessionRequired)
    );
  });

  it('starts a link for every offered provider from a recent browser sign-in', async () => {
    const user = await insertUser();
    await setSessionCookie(user, { authenticatedAt: nowSeconds() });
    const caller = await createSessionCallerForUser(user.id);

    for (const { id } of AccountLinkingProviders) {
      mockCreateLinkingSession.mockClear();
      await expect(caller.user.linkAuthProvider({ provider: id })).resolves.toEqual({
        success: true,
      });
      expect(mockCreateLinkingSession).toHaveBeenCalledWith(user.id, id, undefined, undefined);
    }

    // A method the card does not offer must not open a linking session.
    mockCreateLinkingSession.mockClear();
    await expect(caller.user.linkAuthProvider({ provider: 'workos' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('accepts an older browser sign-in that holds a live step-up proof', async () => {
    const user = await insertUser();
    const webSessionId = `web-session-${randomUUID()}`;
    const [passkey] = await db
      .insert(passkey_credentials)
      .values({
        kilo_user_id: user.id,
        credential_id: `credential-${randomUUID()}`,
        public_key: 'cose-public-key-bytes',
      })
      .returning();
    await db.insert(session_step_up_proofs).values({
      kilo_user_id: user.id,
      session_id_hash: hashWebSessionId(webSessionId),
      method: 'webauthn_uv',
      passkey_credential_id: passkey.id,
      purpose: 'session',
      verified_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    await setSessionCookie(user, { authenticatedAt: STALE_SIGN_IN(), webSessionId });
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.user.linkAuthProvider({ provider: 'github' })).resolves.toEqual({
      success: true,
    });
  });

  it('refuses a link for an SSO domain whose organization does not allow other methods', async () => {
    const { member, organization } = await insertSsoMember();
    await setSessionCookie(member, {
      authenticatedAt: nowSeconds(),
      authProvider: 'workos',
      ssoSourceOrganizationId: organization.id,
    });
    const caller = await createSessionCallerForUser(member.id);

    await expect(caller.user.linkAuthProvider({ provider: 'openai' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.ssoLinkNotAllowed)
    );
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('allows the link for an SSO domain once the organization allows it, from a fresh SSO sign-in only', async () => {
    const { member, organization } = await insertSsoMember();
    await allowNonSsoSignInMethods(organization.id);
    const caller = await createSessionCallerForUser(member.id);

    // A recent sign-in that did not go through the domain's SSO is not enough.
    await setSessionCookie(member, { authenticatedAt: nowSeconds(), authProvider: 'passkey' });
    await expect(caller.user.linkAuthProvider({ provider: 'openai' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.reauthRequired)
    );

    await setSessionCookie(member, {
      authenticatedAt: nowSeconds(),
      authProvider: 'workos',
      ssoSourceOrganizationId: organization.id,
    });
    await expect(caller.user.linkAuthProvider({ provider: 'openai' })).resolves.toEqual({
      success: true,
    });
  });
});

describe('user.unlinkAuthProvider', () => {
  it('refuses an API token and keeps the method', async () => {
    const user = await insertUser();
    await addProvider(user.id, 'google');
    await addProvider(user.id, 'github');
    const caller = await createCallerForUser(user.id);

    await expect(caller.user.unlinkAuthProvider({ provider: 'github' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.browserSessionRequired)
    );
    expect(await providersOf(user.id)).toEqual(['github', 'google']);
  });

  it('refuses a browser session that signed in long ago and keeps the method', async () => {
    const user = await insertUser();
    await addProvider(user.id, 'google');
    await addProvider(user.id, 'github');
    await setSessionCookie(user, { authenticatedAt: STALE_SIGN_IN() });
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.user.unlinkAuthProvider({ provider: 'github' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.reauthRequired)
    );
    expect(await providersOf(user.id)).toEqual(['github', 'google']);
  });

  it('unlinks from a recent sign-in and writes the admin audit row for an admin', async () => {
    const admin = await insertUser({ is_admin: true });
    await addProvider(admin.id, 'google');
    await addProvider(admin.id, 'github');
    await setSessionCookie(admin, { authenticatedAt: nowSeconds() });
    const caller = await createSessionCallerForUser(admin.id);

    await expect(caller.user.unlinkAuthProvider({ provider: 'github' })).resolves.toEqual({
      success: true,
    });

    expect(await providersOf(admin.id)).toEqual(['google']);
    const rows = await db
      .select()
      .from(admin_action_audit_logs)
      .where(
        and(
          eq(admin_action_audit_logs.actor_id, admin.id),
          eq(admin_action_audit_logs.action, 'admin.sign_in_method.unlink')
        )
      );
    expect(rows).toEqual([
      expect.objectContaining({
        target_type: 'user',
        target_id: admin.id,
        metadata: { provider: 'github' },
      }),
    ]);
  });

  it('writes the organization audit row for an SSO member', async () => {
    const { member, organization } = await insertSsoMember();
    await addProvider(member.id, 'google');
    await addProvider(member.id, 'github');
    await setSessionCookie(member, {
      authenticatedAt: nowSeconds(),
      authProvider: 'workos',
      ssoSourceOrganizationId: organization.id,
    });
    const caller = await createSessionCallerForUser(member.id);

    await caller.user.unlinkAuthProvider({ provider: 'github' });

    const rows = await db
      .select()
      .from(organization_audit_logs)
      .where(
        and(
          eq(organization_audit_logs.organization_id, organization.id),
          eq(organization_audit_logs.actor_id, member.id)
        )
      );
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'organization.user.unlink_sign_in_method',
        message: 'User unlinked a GitHub sign-in method',
      }),
    ]);
  });
});

describe('linkAccountToExistingUser audit', () => {
  const identity = (email: string) => ({
    google_user_email: email,
    google_user_name: 'Linked',
    google_user_image_url: '',
    hosted_domain: '@@github@@',
    provider: 'github' as const,
    provider_account_id: `github-${randomUUID()}`,
    display_name: null,
  });

  it('writes the admin audit row when a method is linked to an admin', async () => {
    const admin = await insertUser({ is_admin: true });

    const result = await linkAccountToExistingUser(admin.id, identity('linked@example.net'));

    expect(result.success).toBe(true);
    const rows = await db
      .select()
      .from(admin_action_audit_logs)
      .where(
        and(
          eq(admin_action_audit_logs.actor_id, admin.id),
          eq(admin_action_audit_logs.action, 'admin.sign_in_method.link')
        )
      );
    expect(rows).toEqual([expect.objectContaining({ metadata: { provider: 'github' } })]);
    // The provider account address is not recorded.
    expect(JSON.stringify(rows)).not.toContain('linked@example.net');
  });

  it('writes the organization audit row when a method is linked to an SSO member', async () => {
    const { member, organization } = await insertSsoMember();

    await linkAccountToExistingUser(member.id, identity('member-linked@example.net'));

    const rows = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'organization.user.link_sign_in_method',
        actor_id: member.id,
        message: 'User linked a GitHub sign-in method',
      }),
    ]);
  });
});
