import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';

// The procedures read the browser session from the request cookies and the
// request details from the headers, so the suite serves `next/headers` itself.
const cookieStore = new Map<string, { name: string; value: string }>();
const REQUEST_HEADERS = {
  'x-forwarded-for': '203.0.113.7',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'x-vercel-ip-city': 'San%20Francisco',
  'x-vercel-ip-country': 'US',
};
jest.mock('next/headers', () => ({
  headers: async () => new Headers(REQUEST_HEADERS),
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
  sendSignInMethodRemovedEmail: jest.fn(async () => ({ sent: true })),
  sendSignInMethodChangeCodeEmail: jest.fn(async () => ({ sent: true })),
}));

import { encode, type JWT } from 'next-auth/jwt';
import { and, eq, sql } from 'drizzle-orm';
import {
  admin_action_audit_logs,
  device_sessions,
  magic_link_tokens,
  organization_audit_logs,
  organizations,
  user_auth_provider,
  type User,
} from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  sendNewSignInMethodEmail,
  sendSignInMethodChangeCodeEmail,
  sendSignInMethodRemovedEmail,
} from '@kilocode/web-shared/lib/email';
import {
  deleteTransactionalEmailLogForUsers,
  insertTestUser,
} from '@kilocode/web-shared/tests/helpers/user.helper';
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
import { SIGN_IN_METHOD_REFUSAL_CODES } from '@kilocode/app-shared/auth';
import { normalizeEmail } from '@kilocode/web-shared/lib/email-address';
import { setAdminActionSinkForTest, type AdminActionEvent } from '@/lib/admin/admin-action-audit';

const mockCreateLinkingSession = jest.mocked(createAccountLinkingSession);
const mockSendCode = jest.mocked(sendSignInMethodChangeCodeEmail);
const mockSendRemoved = jest.mocked(sendSignInMethodRemovedEmail);
const mockSendAdded = jest.mocked(sendNewSignInMethodEmail);

const EXPECTED_DETAILS = {
  actor: 'owner' as const,
  occurredAt: expect.any(Date),
  ip: '203.0.113.7',
  location: 'San Francisco, US',
  device: 'Chrome on macOS',
};

type SessionCaller = Awaited<ReturnType<typeof createSessionCallerForUser>>;

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
        authenticatedAt: Math.floor(Date.now() / 1000),
        ...claims,
      },
    }),
  });
}

const createdUserIds: string[] = [];

async function insertUser(fields: Partial<User> = {}) {
  const user = await insertTestUser({ web_session_pepper: randomUUID(), ...fields });
  createdUserIds.push(user.id);
  return user;
}

// The notices this suite sends leave outbox rows that reference its users; a
// later suite in the same worker that deletes every user would hit them. The
// rows go after each test, while the database connection is still open.
afterEach(async () => {
  await deleteTransactionalEmailLogForUsers(createdUserIds.splice(0));
});

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
    cause: expect.objectContaining({ upstreamCode: code }),
  });
}

/** Requests a code and returns the code that the email would carry. */
async function requestCode(
  caller: SessionCaller,
  change: 'link' | 'unlink',
  provider: AuthProviderId
) {
  mockSendCode.mockClear();
  const { challengeId } = await caller.user.requestSignInMethodChangeCode({ change, provider });
  const [[, props]] = mockSendCode.mock.calls;
  return { code: props.code, challengeId };
}

function wrongCode(code: string) {
  return code === '000000' ? '000001' : '000000';
}

/** Moves the account's codes back in time, as if `seconds` had passed. */
async function passTime(user: User, seconds: number) {
  const shift = sql`make_interval(secs => ${seconds}::double precision)`;
  await db
    .update(magic_link_tokens)
    .set({
      created_at: sql`${magic_link_tokens.created_at} - ${shift}`,
      expires_at: sql`${magic_link_tokens.expires_at} - ${shift}`,
    })
    .where(eq(magic_link_tokens.email, normalizeEmail(user.google_user_email)));
}

beforeEach(() => {
  cookieStore.clear();
  mockCreateLinkingSession.mockReset();
  mockSendCode.mockReset();
  mockSendCode.mockResolvedValue({ sent: true });
  mockSendRemoved.mockReset();
  mockSendRemoved.mockResolvedValue({ sent: true });
  mockSendAdded.mockReset();
  mockSendAdded.mockResolvedValue({ sent: true });
});

describe('user.requestSignInMethodChangeCode', () => {
  it('refuses an API token, even when the request also carries a browser session', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'github' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.browserSessionRequired));
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('sends the code to the primary email address and enforces the resend cooldown', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);

    const { challengeId } = await caller.user.requestSignInMethodChangeCode({
      change: 'link',
      provider: 'github',
    });
    expect(challengeId).toEqual(expect.any(String));
    expect(mockSendCode).toHaveBeenCalledWith(
      user.google_user_email,
      expect.objectContaining({ change: 'link', providerName: 'GitHub', expiresInMinutes: 10 })
    );

    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'github' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeCooldown));
  });

  it('reports a send failure and lets the person try again at once', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);

    mockSendCode.mockResolvedValueOnce({ sent: false, reason: 'provider_not_configured' });
    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'github' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeSendFailed));

    mockSendCode.mockRejectedValueOnce(new Error('mail API down'));
    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'github' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeSendFailed));

    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'github' })
    ).resolves.toEqual(expect.objectContaining({ expiresInMinutes: 10 }));
  });
});

describe('user.linkAuthProvider', () => {
  it('refuses an API token', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
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

  it('refuses a browser session whose cookie names another account', async () => {
    const user = await insertUser();
    const other = await insertUser();
    await setSessionCookie(other);
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.user.linkAuthProvider({ provider: 'openai' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.browserSessionRequired)
    );
  });

  it('asks a browser session that signed in before session ids to sign in again', async () => {
    const user = await insertUser();
    await setSessionCookie(user, { webSessionId: undefined });
    const caller = await createSessionCallerForUser(user.id);

    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'github' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.sessionReauthRequired));
    await expect(caller.user.linkAuthProvider({ provider: 'github' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.sessionReauthRequired)
    );
    expect(mockSendCode).not.toHaveBeenCalled();
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('refuses a fresh browser session that sends no code', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.user.linkAuthProvider({ provider: 'github' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid)
    );
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('refuses a wrong code, then accepts the right code once only', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);
    const { code, challengeId } = await requestCode(caller, 'link', 'github');

    await expect(
      caller.user.linkAuthProvider({ provider: 'github', code: wrongCode(code), challengeId })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();

    await expect(
      caller.user.linkAuthProvider({ provider: 'github', code, challengeId })
    ).resolves.toEqual({ success: true });
    expect(mockCreateLinkingSession).toHaveBeenCalledTimes(1);

    await expect(
      caller.user.linkAuthProvider({ provider: 'github', code, challengeId })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));
    expect(mockCreateLinkingSession).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired code', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);
    const { code, challengeId } = await requestCode(caller, 'link', 'github');
    await db
      .update(magic_link_tokens)
      .set({
        created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .where(eq(magic_link_tokens.challenge_id, challengeId));

    await expect(
      caller.user.linkAuthProvider({ provider: 'github', code, challengeId })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('refuses a code made for another change, provider, browser session or user', async () => {
    const user = await insertUser();
    // The unlink code needs a method that can be unlinked.
    await addProvider(user.id, 'google');
    await addProvider(user.id, 'github');
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);

    const unlinkCode = await requestCode(caller, 'unlink', 'github');
    await expect(
      caller.user.linkAuthProvider({ provider: 'github', ...unlinkCode })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));

    await db.delete(magic_link_tokens).where(eq(magic_link_tokens.email, user.google_user_email));
    const gitlabCode = await requestCode(caller, 'link', 'gitlab');
    await expect(
      caller.user.linkAuthProvider({ provider: 'github', ...gitlabCode })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));

    await db.delete(magic_link_tokens).where(eq(magic_link_tokens.email, user.google_user_email));
    const sessionCode = await requestCode(caller, 'link', 'github');
    // The same account signs in again in another browser session.
    await setSessionCookie(user);
    await expect(
      caller.user.linkAuthProvider({ provider: 'github', ...sessionCode })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));

    const other = await insertUser();
    await setSessionCookie(other);
    const otherCaller = await createSessionCallerForUser(other.id);
    const otherCode = await requestCode(otherCaller, 'link', 'github');
    await setSessionCookie(user);
    await expect(
      caller.user.linkAuthProvider({ provider: 'github', ...otherCode })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));

    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('locks the code after too many wrong codes and sends no new code', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);
    const { code, challengeId } = await requestCode(caller, 'link', 'github');

    for (let attempt = 1; attempt < 5; attempt++) {
      await expect(
        caller.user.linkAuthProvider({ provider: 'github', code: wrongCode(code), challengeId })
      ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));
    }
    await expect(
      caller.user.linkAuthProvider({ provider: 'github', code: wrongCode(code), challengeId })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked));
    // The right code does not work after the lock.
    await expect(
      caller.user.linkAuthProvider({ provider: 'github', code, challengeId })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked));

    mockSendCode.mockClear();
    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'github' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked));
    expect(mockSendCode).not.toHaveBeenCalled();
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('counts wrong codes across new codes, so a new code does not reset the limit', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);
    const first = await requestCode(caller, 'link', 'github');

    for (let attempt = 1; attempt < 5; attempt++) {
      await expect(
        caller.user.linkAuthProvider({
          provider: 'github',
          code: wrongCode(first.code),
          challengeId: first.challengeId,
        })
      ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));
    }

    // Past the resend cooldown, a new code still carries the four wrong codes.
    await passTime(user, 61);
    const second = await requestCode(caller, 'link', 'github');
    await expect(
      caller.user.linkAuthProvider({
        provider: 'github',
        code: wrongCode(second.code),
        challengeId: second.challengeId,
      })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked));
    await expect(caller.user.linkAuthProvider({ provider: 'github', ...second })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked)
    );
    expect(mockCreateLinkingSession).not.toHaveBeenCalled();
  });

  it('keeps the lock for 15 minutes from the fifth wrong code, not from when the code was sent', async () => {
    const user = await insertUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);
    const { code, challengeId } = await requestCode(caller, 'link', 'github');
    // The code was sent 9 minutes ago and still works.
    await passTime(user, 9 * 60);

    for (let attempt = 1; attempt < 5; attempt++) {
      await expect(
        caller.user.linkAuthProvider({ provider: 'github', code: wrongCode(code), challengeId })
      ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid));
    }
    await expect(
      caller.user.linkAuthProvider({ provider: 'github', code: wrongCode(code), challengeId })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked));

    // 14 minutes after the fifth wrong code, 23 after the code was sent.
    await passTime(user, 14 * 60);
    mockSendCode.mockClear();
    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'github' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeLocked));
    expect(mockSendCode).not.toHaveBeenCalled();

    await passTime(user, 61);
    const fresh = await requestCode(caller, 'link', 'github');
    await expect(caller.user.linkAuthProvider({ provider: 'github', ...fresh })).resolves.toEqual({
      success: true,
    });
  });

  it('starts a link for every offered provider with its code, bound to this browser session', async () => {
    const user = await insertUser();
    await setSessionCookie(user, { webSessionId: 'web-session-link-start' });
    const caller = await createSessionCallerForUser(user.id);

    for (const { id } of AccountLinkingProviders) {
      mockCreateLinkingSession.mockClear();
      const { code, challengeId } = await requestCode(caller, 'link', id);
      await expect(
        caller.user.linkAuthProvider({ provider: id, code, challengeId })
      ).resolves.toEqual({ success: true });
      expect(mockCreateLinkingSession).toHaveBeenCalledWith({
        existingUserId: user.id,
        webSessionId: 'web-session-link-start',
        targetProvider: id,
        organizationId: undefined,
        chatGptScope: undefined,
      });
    }

    // A method the card does not offer must not get a code or a linking session.
    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'workos' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a link for an SSO domain whose organization does not allow other methods', async () => {
    const { member, organization } = await insertSsoMember();
    await setSessionCookie(member, {
      authProvider: 'workos',
      ssoSourceOrganizationId: organization.id,
    });
    const caller = await createSessionCallerForUser(member.id);

    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'link', provider: 'openai' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.ssoLinkNotAllowed));
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('allows the link for an SSO domain once the organization allows it', async () => {
    const { member, organization } = await insertSsoMember();
    await allowNonSsoSignInMethods(organization.id);
    await setSessionCookie(member, {
      authProvider: 'workos',
      ssoSourceOrganizationId: organization.id,
    });
    const caller = await createSessionCallerForUser(member.id);
    const { code, challengeId } = await requestCode(caller, 'link', 'openai');

    await expect(
      caller.user.linkAuthProvider({ provider: 'openai', code, challengeId })
    ).resolves.toEqual({ success: true });
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

  it('refuses a fresh browser session without a code and keeps the method', async () => {
    const user = await insertUser();
    await addProvider(user.id, 'google');
    await addProvider(user.id, 'github');
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.user.unlinkAuthProvider({ provider: 'github' })).rejects.toEqual(
      refusedWith(SIGN_IN_METHOD_CHANGE_REFUSAL_CODES.codeInvalid)
    );
    expect(await providersOf(user.id)).toEqual(['github', 'google']);
    expect(mockSendRemoved).not.toHaveBeenCalled();
  });

  it('sends no code for an unlink that would remove the last method or a method not linked', async () => {
    const user = await insertUser();
    await addProvider(user.id, 'google');
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);

    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'unlink', provider: 'google' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_REFUSAL_CODES.lastMethod));

    await addProvider(user.id, 'github');
    await expect(
      caller.user.requestSignInMethodChangeCode({ change: 'unlink', provider: 'gitlab' })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_REFUSAL_CODES.notLinked));
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('does not spend the code when the unlink is refused', async () => {
    const user = await insertUser();
    await addProvider(user.id, 'google');
    await addProvider(user.id, 'github');
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);
    const { code, challengeId } = await requestCode(caller, 'unlink', 'github');

    await db
      .delete(user_auth_provider)
      .where(
        and(eq(user_auth_provider.kilo_user_id, user.id), eq(user_auth_provider.provider, 'google'))
      );
    await expect(
      caller.user.unlinkAuthProvider({ provider: 'github', code, challengeId })
    ).rejects.toEqual(refusedWith(SIGN_IN_METHOD_REFUSAL_CODES.lastMethod));
    expect(await providersOf(user.id)).toEqual(['github']);
    expect(mockSendRemoved).not.toHaveBeenCalled();

    await addProvider(user.id, 'google');
    await expect(
      caller.user.unlinkAuthProvider({ provider: 'github', code, challengeId })
    ).resolves.toEqual({ success: true });
    expect(await providersOf(user.id)).toEqual(['google']);
    expect(mockSendRemoved).toHaveBeenCalledTimes(1);
  });

  it('unlinks with the code, writes the admin audit row and sends the notice', async () => {
    const admin = await insertUser({ is_admin: true });
    await addProvider(admin.id, 'google');
    await addProvider(admin.id, 'github');
    await setSessionCookie(admin);
    const caller = await createSessionCallerForUser(admin.id);
    const { code, challengeId } = await requestCode(caller, 'unlink', 'github');

    await expect(
      caller.user.unlinkAuthProvider({ provider: 'github', code, challengeId })
    ).resolves.toEqual({ success: true });

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
    expect(mockSendRemoved).toHaveBeenCalledWith(
      admin.google_user_email,
      'GitHub',
      EXPECTED_DETAILS
    );
  });

  it('keeps the unlink when the notice email fails', async () => {
    const user = await insertUser();
    await addProvider(user.id, 'google');
    await addProvider(user.id, 'github');
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);
    const { code, challengeId } = await requestCode(caller, 'unlink', 'github');
    mockSendRemoved.mockRejectedValueOnce(new Error('mail API down'));

    await expect(
      caller.user.unlinkAuthProvider({ provider: 'github', code, challengeId })
    ).resolves.toEqual({ success: true });
    expect(await providersOf(user.id)).toEqual(['google']);
  });

  it('writes the organization audit row for an SSO member', async () => {
    const { member, organization } = await insertSsoMember();
    await addProvider(member.id, 'google');
    await addProvider(member.id, 'github');
    await setSessionCookie(member, {
      authProvider: 'workos',
      ssoSourceOrganizationId: organization.id,
    });
    const caller = await createSessionCallerForUser(member.id);
    const { code, challengeId } = await requestCode(caller, 'unlink', 'github');

    await caller.user.unlinkAuthProvider({ provider: 'github', code, challengeId });

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

describe('linkAccountToExistingUser', () => {
  const identity = (email: string) => ({
    google_user_email: email,
    google_user_name: 'Linked',
    google_user_image_url: '',
    hosted_domain: '@@github@@',
    provider: 'github' as const,
    provider_account_id: `github-${randomUUID()}`,
    display_name: null,
  });

  it('writes the admin audit row with the request IP address when a method is linked to an admin', async () => {
    const admin = await insertUser({ is_admin: true });
    const events: AdminActionEvent[] = [];
    setAdminActionSinkForTest(event => events.push(event));

    try {
      const result = await linkAccountToExistingUser(admin.id, identity('linked@example.net'));
      expect(result.success).toBe(true);
    } finally {
      setAdminActionSinkForTest(null);
    }

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
    expect(events).toEqual([
      expect.objectContaining({ action: 'admin.sign_in_method.link', ip: '203.0.113.7' }),
    ]);
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

  it('sends the notice with the request IP address, location and browser', async () => {
    const user = await insertUser();

    await linkAccountToExistingUser(user.id, identity('notice@example.net'));

    expect(mockSendAdded).toHaveBeenCalledWith(
      user.google_user_email,
      'GitHub',
      { email: 'notice@example.net', displayName: null },
      { kind: 'added' },
      EXPECTED_DETAILS
    );
  });

  it('keeps the link when the notice email fails', async () => {
    const user = await insertUser();
    mockSendAdded.mockRejectedValueOnce(new Error('mail API down'));

    const result = await linkAccountToExistingUser(user.id, identity('fails@example.net'));

    expect(result.success).toBe(true);
    expect(await providersOf(user.id)).toContain('github');
  });
});
