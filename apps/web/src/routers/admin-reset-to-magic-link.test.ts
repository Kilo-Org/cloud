jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store');
  return { ...actual, revokeStepUpProofs: jest.fn(actual.revokeStepUpProofs) };
});

// The concurrency cases poll for a Postgres lock wait, so a single case needs
// more than the default 5s budget.
jest.setTimeout(30_000);

import { describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { revokeStepUpProofs } from '@kilocode/web-shared/lib/admin/step-up-store';
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
  buildRegistrationResponse,
  createTestAuthenticator,
  type TestAuthenticator,
} from '@/tests/helpers/webauthn-test-authenticator';
import {
  consumeSignInTicket,
  createAuthenticationOptions,
  createRegistrationOptions,
  PasskeyVerificationError,
  verifyAuthentication,
  verifyRegistration,
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

/**
 * A lock probe gives up after this long. A shared CI database can hold the
 * probe behind another suite's transaction, so the budget is generous enough
 * that only a genuinely stuck test reaches it.
 */
const LOCK_PROBE_DEADLINE_MS = 20_000;
const LOCK_PROBE_INTERVAL_MS = 25;

/**
 * The advisory key a test parks a ceremony's inserts on, derived from the user
 * id under test. A key from one test cannot park or release another test's
 * statements, so no constant key is shared across the suite or its workers.
 */
function advisoryKeyFor(userId: string): string {
  const digest = createHash('sha256').update(userId).digest();
  return BigInt.asUintN(63, digest.readBigUInt64BE(0)).toString();
}

/**
 * Polls `probe` until it answers. Postgres reports a blocked statement only
 * through `pg_locks` and `pg_stat_activity`, so there is no event to await.
 */
async function waitFor<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
  const deadline = Date.now() + LOCK_PROBE_DEADLINE_MS;
  for (;;) {
    const answer = await probe();
    if (answer !== null) return answer;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${LOCK_PROBE_DEADLINE_MS} ms waiting for ${what}; ` +
          `lock waits in this database: ${await describeLockWaits()}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, LOCK_PROBE_INTERVAL_MS));
  }
}

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  await waitFor(async () => ((await condition()) ? true : null), what);
}

/** What this test process is waiting on, for a timeout message. */
async function describeLockWaits(): Promise<string> {
  const result = await db.execute<{ pid: number; wait: string }>(
    sql`SELECT pid, coalesce(wait_event_type || ':' || wait_event, 'none') AS wait
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = current_setting('application_name')
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'`
  );
  return JSON.stringify(result.rows);
}

/**
 * The backend parked on `key`. Only the key this test derived is read, so a
 * lock wait in another test or another worker of the shared database cannot be
 * mistaken for this one.
 */
async function parkedBackendPid(key: string): Promise<number | null> {
  const result = await db.execute<{ pid: number }>(
    sql`SELECT pid FROM pg_locks
         WHERE locktype = 'advisory' AND objsubid = 1 AND NOT granted
           AND ((classid::bigint << 32) | objid::bigint) = ${key}::bigint
         LIMIT 1`
  );
  return result.rows[0]?.pid ?? null;
}

/** True when another backend waits for the transaction of `pid` to end. */
async function isBlockedBy(pid: number): Promise<boolean> {
  const result = await db.execute<{ blocked: boolean }>(
    sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
             AND ${pid} = ANY(pg_blocking_pids(pid))
        ) AS blocked`
  );
  return result.rows[0].blocked;
}

/**
 * Parks every insert into `table` for `userId` on an advisory lock until the
 * returned release runs, so a test can act between a passkey ceremony's lock
 * and the row it writes. Deletes are not affected. The returned `key` names the
 * only lock the hold can park a statement on.
 */
async function holdInserts(
  table: 'passkey_sign_in_tickets' | 'passkey_credentials',
  userId: string
) {
  const name = `hold_insert_${crypto.randomUUID().replaceAll('-', '')}`;
  const lockKey = advisoryKeyFor(userId);
  await db.execute(
    sql.raw(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ ` +
        `BEGIN PERFORM pg_advisory_xact_lock(${lockKey}); RETURN NEW; END $$`
    )
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW ` +
        `WHEN (NEW.kilo_user_id = '${userId}') EXECUTE FUNCTION ${name}()`
    )
  );
  const locked = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const holder = db.transaction(async tx => {
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${lockKey})`));
    locked.resolve();
    await released.promise;
  });
  await locked.promise;
  return {
    key: lockKey,
    async release() {
      released.resolve();
      await holder;
    },
    async drop() {
      await db.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}`));
      await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
    },
  };
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
    // A proof is bound to a passkey and cascades away with it, so the row
    // alone cannot show the revocation; the spy does.
    expect(after.stepUpProofs).toEqual([]);
    expect(jest.mocked(revokeStepUpProofs)).toHaveBeenCalledWith(
      user.id,
      'account_recovery',
      expect.anything()
    );
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

  test('recovery during a passkey sign-in leaves no redeemable ticket', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const authenticator = createTestAuthenticator();
    await insertPasskey(user.id, authenticator);
    const { challengeId, options } = await createAuthenticationOptions();
    const response = buildAuthenticationResponse(authenticator, {
      challenge: options.challenge,
      counter: 1,
    });
    const caller = await createCallerForUser(admin.id);

    const hold = await holdInserts('passkey_sign_in_tickets', user.id);
    try {
      // The assertion verifies and its counter update runs, then the ticket
      // insert parks on the hold. The no-op catch keeps an early rejection
      // from going unhandled; the promise is still awaited below.
      const verification = verifyAuthentication(challengeId, response);
      void verification.catch(() => undefined);
      const ceremonyPid = await waitFor(
        () => parkedBackendPid(hold.key),
        'the ticket insert to park'
      );

      // Recovery now runs. It must not finish before the in-flight sign-in
      // does: it waits on the credential row the sign-in still holds.
      let recoverySettled = false;
      const recovery = caller.admin.users
        .resetToMagicLinkLogin({ userId: user.id })
        .finally(() => (recoverySettled = true));
      await waitUntil(
        async () => recoverySettled || (await isBlockedBy(ceremonyPid)),
        'recovery to finish or wait on the credential'
      );
      expect(recoverySettled).toBe(false);

      await hold.release();
      const { ticket } = await verification;
      await expect(recovery).resolves.toEqual({ success: true });

      await expect(consumeSignInTicket(ticket)).resolves.toBeNull();
      const tickets = await db
        .select({ id: passkey_sign_in_tickets.id })
        .from(passkey_sign_in_tickets)
        .where(eq(passkey_sign_in_tickets.kilo_user_id, user.id));
      expect(tickets).toEqual([]);
    } finally {
      await hold.release();
      await hold.drop();
    }
  });

  test('recovery during a passkey registration leaves no credential', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ web_session_pepper: 'holder-session-pepper' });
    const authenticator = createTestAuthenticator();
    const { challengeId, options } = await createRegistrationOptions(
      user.id,
      user.google_user_email
    );
    const attestation = buildRegistrationResponse(authenticator, {
      challenge: options.challenge,
    });
    const caller = await createCallerForUser(admin.id);

    const hold = await holdInserts('passkey_credentials', user.id);
    try {
      // The registration locks the user row, finds its session current, and
      // its credential insert parks on the hold.
      const registration = verifyRegistration(
        user.id,
        challengeId,
        attestation,
        'holder-session-pepper'
      );
      void registration.catch(() => undefined);
      const ceremonyPid = await waitFor(
        () => parkedBackendPid(hold.key),
        'the credential insert to park'
      );

      // Recovery rotates the pepper on the row the registration holds, so it
      // waits for the registration to commit before it deletes passkeys.
      let recoverySettled = false;
      const recovery = caller.admin.users
        .resetToMagicLinkLogin({ userId: user.id })
        .finally(() => (recoverySettled = true));
      await waitUntil(
        async () => recoverySettled || (await isBlockedBy(ceremonyPid)),
        'recovery to finish or wait on the user row'
      );
      expect(recoverySettled).toBe(false);

      await hold.release();
      await expect(registration).resolves.toMatchObject({ kilo_user_id: user.id });
      await expect(recovery).resolves.toEqual({ success: true });

      const passkeys = await db
        .select({ id: passkey_credentials.id })
        .from(passkey_credentials)
        .where(eq(passkey_credentials.kilo_user_id, user.id));
      expect(passkeys).toEqual([]);
    } finally {
      await hold.release();
      await hold.drop();
    }
  });

  test('a registration from a session that recovery revoked is refused', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ web_session_pepper: 'holder-session-pepper' });
    const caller = await createCallerForUser(admin.id);
    await caller.admin.users.resetToMagicLinkLogin({ userId: user.id });

    // Recovery deletes open challenges, so the ceremony starts afterwards: only
    // the revoked session pepper can refuse it.
    const { challengeId, options } = await createRegistrationOptions(
      user.id,
      user.google_user_email
    );

    const refusal: unknown = await verifyRegistration(
      user.id,
      challengeId,
      buildRegistrationResponse(createTestAuthenticator(), { challenge: options.challenge }),
      'holder-session-pepper'
    ).then(
      () => null,
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(PasskeyVerificationError);
    expect((refusal as PasskeyVerificationError).code).toBe('VERIFICATION_FAILED');
    const passkeys = await db
      .select({ id: passkey_credentials.id })
      .from(passkey_credentials)
      .where(eq(passkey_credentials.kilo_user_id, user.id));
    expect(passkeys).toEqual([]);
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
