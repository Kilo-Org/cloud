jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual('@sentry/nextjs'),
  captureException: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store');
  return { ...actual, revokeStepUpProofs: jest.fn(actual.revokeStepUpProofs) };
});

import { afterEach, describe, expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import {
  admin_action_audit_logs,
  device_auth_requests,
  device_refresh_tokens,
  device_sessions,
  kilocode_users,
  native_attested_keys,
  passkey_credentials,
  user_auth_provider,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { revokeStepUpProofs } from '@kilocode/web-shared/lib/admin/step-up-store';
import { isWebSessionCurrent } from '@kilocode/web-shared/lib/web-session-revocation';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

const mockRevokeStepUpProofs = jest.mocked(revokeStepUpProofs);
const mockCaptureException = jest.mocked(captureException);

async function insertHeldAccount() {
  const user = await insertTestUser({
    google_user_email: `held-${crypto.randomUUID()}@example.com`,
    web_session_pepper: 'prior-holder-web-pepper',
    api_token_pepper: 'prior-holder-api-pepper',
  });
  await db.insert(user_auth_provider).values({
    kilo_user_id: user.id,
    provider: 'github',
    provider_account_id: `github-${user.id}`,
    email: user.google_user_email,
    avatar_url: '',
    display_name: null,
    hosted_domain: 'example.com',
  });
  const [session] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: user.id, user_agent: 'prior-holder-phone' })
    .returning({ id: device_sessions.id });
  await db.insert(device_refresh_tokens).values({
    token_hash: `refresh-${user.id}`,
    device_session_id: session.id,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await db.insert(device_auth_requests).values({
    code: `code-${user.id}`,
    kilo_user_id: user.id,
    status: 'approved',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  await db.insert(native_attested_keys).values({
    key_id: `key-${user.id}`,
    kilo_user_id: user.id,
    platform: 'ios',
    public_key: 'public-key',
    attested_at: new Date().toISOString(),
  });
  await db.insert(passkey_credentials).values({
    kilo_user_id: user.id,
    credential_id: `passkey-${user.id}`,
    public_key: 'passkey-public-key',
  });
  return { user };
}

async function accountState(userId: string) {
  const [user] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));
  const providers = await db
    .select({ provider: user_auth_provider.provider })
    .from(user_auth_provider)
    .where(eq(user_auth_provider.kilo_user_id, userId));
  const sessions = await db
    .select({
      revoked_at: device_sessions.revoked_at,
      revoked_reason: device_sessions.revoked_reason,
    })
    .from(device_sessions)
    .where(eq(device_sessions.kilo_user_id, userId));
  const refreshTokens = await db
    .select({ token_hash: device_refresh_tokens.token_hash })
    .from(device_refresh_tokens)
    .where(eq(device_refresh_tokens.token_hash, `refresh-${userId}`));
  const authRequests = await db
    .select({ status: device_auth_requests.status })
    .from(device_auth_requests)
    .where(eq(device_auth_requests.kilo_user_id, userId));
  const attestedKeys = await db
    .select({ key_id: native_attested_keys.key_id })
    .from(native_attested_keys)
    .where(eq(native_attested_keys.kilo_user_id, userId));
  const passkeys = await db
    .select({ id: passkey_credentials.id })
    .from(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, userId));
  return { user, providers, sessions, refreshTokens, authRequests, attestedKeys, passkeys };
}

afterEach(() => {
  mockRevokeStepUpProofs.mockClear();
  mockCaptureException.mockClear();
});

describe('admin.users.resetToMagicLinkLogin', () => {
  test('removes providers and evicts every live credential of the prior holder', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const { user } = await insertHeldAccount();

    const caller = await createCallerForUser(admin.id);
    await expect(caller.admin.users.resetToMagicLinkLogin({ userId: user.id })).resolves.toEqual({
      success: true,
    });

    const after = await accountState(user.id);
    expect(after.providers).toEqual([]);
    expect(after.user.api_token_pepper).not.toBe('prior-holder-api-pepper');
    expect(after.user.api_token_pepper).toEqual(expect.any(String));
    expect(isWebSessionCurrent('prior-holder-web-pepper', after.user)).toBe(false);
    expect(after.sessions).toEqual([
      { revoked_at: expect.any(String), revoked_reason: 'account_recovery' },
    ]);
    expect(after.refreshTokens).toEqual([]);
    expect(after.authRequests).toEqual([{ status: 'denied' }]);
    expect(after.attestedKeys).toEqual([]);
    expect(after.passkeys).toHaveLength(1);
    expect(mockRevokeStepUpProofs).toHaveBeenCalledWith(
      user.id,
      'account_recovery',
      expect.anything()
    );

    const audits = await db
      .select()
      .from(admin_action_audit_logs)
      .where(eq(admin_action_audit_logs.actor_id, admin.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'user.login.reset_to_magic_link',
      target_id: user.id,
      metadata: { removedProviders: ['github'], revokedDeviceSessionCount: 1 },
    });
  });

  test.each([
    [
      'a retryable',
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      'Account recovery did not complete and the previous sessions were not revoked. Retry the reset.',
      false,
    ],
    [
      'a non-retryable',
      new Error('relation is missing'),
      'Account recovery failed and the previous sessions were not revoked. Investigate the error before retrying.',
      true,
    ],
  ])(
    'surfaces %s revocation failure and leaves the account unchanged',
    async (_label, failure, message, reported) => {
      const admin = await insertTestUser({ is_admin: true });
      const { user } = await insertHeldAccount();
      mockRevokeStepUpProofs.mockRejectedValueOnce(failure);

      const caller = await createCallerForUser(admin.id);
      await expect(
        caller.admin.users.resetToMagicLinkLogin({ userId: user.id })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message });

      const after = await accountState(user.id);
      expect(after.providers).toEqual([{ provider: 'github' }]);
      expect(after.user.api_token_pepper).toBe('prior-holder-api-pepper');
      expect(after.user.web_session_pepper).toBe('prior-holder-web-pepper');
      expect(after.sessions).toEqual([{ revoked_at: null, revoked_reason: null }]);
      expect(after.refreshTokens).toHaveLength(1);
      expect(after.authRequests).toEqual([{ status: 'approved' }]);
      expect(after.attestedKeys).toHaveLength(1);
      expect(mockCaptureException).toHaveBeenCalledTimes(reported ? 1 : 0);

      const audits = await db
        .select()
        .from(admin_action_audit_logs)
        .where(eq(admin_action_audit_logs.actor_id, admin.id));
      expect(audits).toEqual([]);
    }
  );

  test('reports a missing user as not found', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.resetToMagicLinkLogin({ userId: 'missing-recovery-user' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
