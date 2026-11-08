import { describe, expect, test } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  admin_action_audit_logs,
  device_auth_requests,
  device_refresh_tokens,
  device_sessions,
  kilocode_users,
  native_attested_keys,
  passkey_challenges,
  passkey_credentials,
  passkey_sign_in_tickets,
  session_step_up_proofs,
  user_auth_provider,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { isWebSessionCurrent } from '@kilocode/web-shared/lib/web-session-revocation';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  buildAuthenticationResponse,
  createTestAuthenticator,
  type TestAuthenticator,
} from '@/tests/helpers/webauthn-test-authenticator';
import {
  consumeSignInTicket,
  createAuthenticationOptions,
  PasskeyVerificationError,
  verifyAuthentication,
} from '@/lib/auth/passkey';
import { getPostgresErrorCode } from '@/lib/db-errors';
import { createCallerForUser } from '@/routers/test-utils';

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
  const authenticator = createTestAuthenticator();
  const passkeyId = await insertPasskey(user.id, authenticator);
  await db.insert(session_step_up_proofs).values({
    kilo_user_id: user.id,
    session_id_hash: `session-${user.id}`,
    method: 'webauthn_uv',
    passkey_credential_id: passkeyId,
    purpose: 'session',
    verified_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  await db.insert(passkey_challenges).values({
    id: crypto.randomUUID(),
    challenge: `challenge-${user.id}`,
    kind: 'registration',
    kilo_user_id: user.id,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  await db.insert(passkey_sign_in_tickets).values({
    ticket_hash: `ticket-${user.id}`,
    kilo_user_id: user.id,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  return { user };
}

async function insertPasskey(userId: string, authenticator: TestAuthenticator) {
  const [passkey] = await db
    .insert(passkey_credentials)
    .values({
      kilo_user_id: userId,
      credential_id: authenticator.credentialId,
      public_key: isoBase64URL.fromBuffer(authenticator.cosePublicKey),
    })
    .returning({ id: passkey_credentials.id });
  return passkey.id;
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
  const stepUpProofs = await db
    .select({ revoked_reason: session_step_up_proofs.revoked_reason })
    .from(session_step_up_proofs)
    .where(eq(session_step_up_proofs.kilo_user_id, userId));
  const passkeys = await db
    .select({ id: passkey_credentials.id })
    .from(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, userId));
  const challenges = await db
    .select({ id: passkey_challenges.id })
    .from(passkey_challenges)
    .where(eq(passkey_challenges.kilo_user_id, userId));
  const tickets = await db
    .select({ id: passkey_sign_in_tickets.id })
    .from(passkey_sign_in_tickets)
    .where(eq(passkey_sign_in_tickets.kilo_user_id, userId));
  return {
    user,
    providers,
    sessions,
    refreshTokens,
    authRequests,
    attestedKeys,
    stepUpProofs,
    passkeys,
    challenges,
    tickets,
  };
}

async function adminAudits(adminId: string) {
  return db
    .select()
    .from(admin_action_audit_logs)
    .where(eq(admin_action_audit_logs.actor_id, adminId));
}

/**
 * Makes deleting this user's passkey sign-in tickets raise `sqlState`. That
 * delete is the last statement of the reset, so every other write has already
 * run inside the transaction when the real driver error surfaces.
 */
async function withFailingTicketDelete<T>(
  userId: string,
  sqlState: string,
  run: () => Promise<T>
): Promise<T> {
  const name = `fail_ticket_delete_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql.raw(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ ` +
        `BEGIN RAISE EXCEPTION 'injected recovery failure' USING ERRCODE = '${sqlState}'; END $$`
    )
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER ${name} BEFORE DELETE ON passkey_sign_in_tickets FOR EACH ROW ` +
        `WHEN (OLD.kilo_user_id = '${userId}') EXECUTE FUNCTION ${name}()`
    )
  );
  try {
    return await run();
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER ${name} ON passkey_sign_in_tickets`));
    await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
  }
}

async function signInWithPasskey(authenticator: TestAuthenticator, counter: number) {
  const { challengeId, options } = await createAuthenticationOptions();
  return verifyAuthentication(
    challengeId,
    buildAuthenticationResponse(authenticator, { challenge: options.challenge, counter })
  );
}

describe('admin.users.resetToMagicLinkLogin', () => {
  test('removes providers and passkeys and evicts every live credential of the prior holder', async () => {
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
    // Revoked first, then removed with the passkey it was bound to.
    expect(after.stepUpProofs).toEqual([]);
    expect(after.passkeys).toEqual([]);
    expect(after.challenges).toEqual([]);
    expect(after.tickets).toEqual([]);

    const audits = await adminAudits(admin.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'user.login.reset_to_magic_link',
      target_id: user.id,
      metadata: {
        removedProviders: ['github'],
        removedPasskeyCount: 1,
        revokedDeviceSessionCount: 1,
      },
    });
  });

  test('a passkey the prior holder registered no longer signs in after recovery', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const authenticator = createTestAuthenticator();
    await insertPasskey(user.id, authenticator);

    const { ticket: pendingTicket } = await signInWithPasskey(authenticator, 1);

    const caller = await createCallerForUser(admin.id);
    await caller.admin.users.resetToMagicLinkLogin({ userId: user.id });

    await expect(consumeSignInTicket(pendingTicket)).resolves.toBeNull();
    const refusal: unknown = await signInWithPasskey(authenticator, 2).then(
      () => null,
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(PasskeyVerificationError);
    expect((refusal as PasskeyVerificationError).code).toBe('UNKNOWN_CREDENTIAL');
  });

  test.each([
    {
      label: 'a retryable',
      sqlState: '40P01',
      code: 'CONFLICT',
      message:
        'Account recovery did not complete and the previous sessions were not revoked. Retry the reset.',
    },
    {
      label: 'a non-retryable',
      sqlState: 'P0001',
      code: 'INTERNAL_SERVER_ERROR',
      message:
        'Account recovery failed and the previous sessions were not revoked. Investigate the error before retrying.',
    },
  ])(
    'surfaces $label failure after the revocation writes and rolls all of them back',
    async ({ sqlState, code, message }) => {
      const admin = await insertTestUser({ is_admin: true });
      const { user } = await insertHeldAccount();
      const before = await accountState(user.id);

      const caller = await createCallerForUser(admin.id);
      const error: unknown = await withFailingTicketDelete(user.id, sqlState, () =>
        caller.admin.users.resetToMagicLinkLogin({ userId: user.id }).then(
          () => null,
          (rejection: unknown) => rejection
        )
      );

      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({ code, message });
      // The cause is the driver error as Drizzle surfaced it, not a fixture.
      expect(getPostgresErrorCode((error as TRPCError).cause)).toBe(sqlState);

      const after = await accountState(user.id);
      expect(after).toEqual(before);
      expect(await adminAudits(admin.id)).toEqual([]);
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
