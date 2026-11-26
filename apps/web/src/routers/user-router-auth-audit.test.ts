import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auth_audit_logs, device_sessions, passkey_credentials } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';
import { setAuthActionSinkForTest, type AuthActionEvent } from '@/lib/auth/auth-audit';

let events: AuthActionEvent[];

beforeEach(() => {
  events = [];
  setAuthActionSinkForTest(event => events.push(event));
});

afterEach(() => {
  setAuthActionSinkForTest(null);
});

async function authRowsFor(userId: string) {
  return db.select().from(auth_audit_logs).where(eq(auth_audit_logs.user_id, userId));
}

async function insertUser() {
  return insertTestUser({
    google_user_email: `auth-audit-${randomUUID()}@example.com`,
    web_session_pepper: randomUUID(),
  });
}

async function insertDeviceSession(userId: string) {
  const [row] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: userId, user_agent: 'Kilo-Code/1.2.3 (ios)' })
    .returning({ id: device_sessions.id });
  return row.id;
}

describe('self-service API key reset', () => {
  it('records a success row with the number of revoked device sessions', async () => {
    const user = await insertUser();
    await insertDeviceSession(user.id);
    const caller = await createSessionCallerForUser(user.id);

    await caller.user.resetAPIKey();

    expect(await authRowsFor(user.id)).toEqual([
      expect.objectContaining({
        action: 'auth.api_key.reset',
        outcome: 'success',
        user_id: user.id,
        method: 'session',
        failure_reason: null,
        metadata: { revokedDeviceSessionCount: 1 },
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.api_key.reset',
        outcome: 'success',
        persisted: true,
      }),
    ]);
  });

  it('records a failure row when the reset fails, and still fails the call', async () => {
    const user = await insertUser();
    const caller = await createSessionCallerForUser(user.id);
    const transaction = jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('db down'));

    try {
      await expect(caller.user.resetAPIKey()).rejects.toThrow();
    } finally {
      transaction.mockRestore();
    }

    expect(await authRowsFor(user.id)).toEqual([
      expect.objectContaining({
        action: 'auth.api_key.reset',
        outcome: 'failure',
        user_id: user.id,
        method: 'session',
        failure_reason: 'internal_error',
      }),
    ]);
  });
});

describe('sign-out', () => {
  it('records signing out every browser session', async () => {
    const user = await insertUser();
    const caller = await createSessionCallerForUser(user.id);

    await caller.user.signOutBrowserSessions();

    expect(await authRowsFor(user.id)).toEqual([
      expect.objectContaining({
        action: 'auth.sessions.revoke_all',
        outcome: 'success',
        user_id: user.id,
        method: 'session',
        failure_reason: null,
      }),
    ]);
  });

  it('records an app logout with its device session', async () => {
    const user = await insertUser();
    const sessionId = await insertDeviceSession(user.id);
    const caller = await createCallerForUser(user.id, { deviceSessionId: sessionId });

    await caller.user.revokeCurrentDeviceSession();

    expect(await authRowsFor(user.id)).toEqual([
      expect.objectContaining({
        action: 'auth.device_session.revoke',
        outcome: 'success',
        user_id: user.id,
        method: 'logout',
        failure_reason: null,
        metadata: { deviceSessionId: sessionId },
      }),
    ]);
  });

  it('records a revoke that named another account session as a failure, answering as before', async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const sessionId = await insertDeviceSession(owner.id);
    const caller = await createCallerForUser(other.id);

    await expect(caller.user.revokeDeviceSessionById({ sessionId })).resolves.toEqual({
      success: true,
    });

    expect(await authRowsFor(other.id)).toEqual([
      expect.objectContaining({
        action: 'auth.device_session.revoke',
        outcome: 'failure',
        user_id: other.id,
        method: 'user_revoked',
        failure_reason: 'session_not_active',
        metadata: { deviceSessionId: sessionId },
      }),
    ]);
    const [session] = await db
      .select({ revoked_at: device_sessions.revoked_at })
      .from(device_sessions)
      .where(eq(device_sessions.id, sessionId));
    expect(session?.revoked_at).toBeNull();
  });
});

describe('passkey management', () => {
  async function insertPasskey(userId: string) {
    const [row] = await db
      .insert(passkey_credentials)
      .values({
        kilo_user_id: userId,
        credential_id: `credential-${randomUUID()}`,
        public_key: 'cose-public-key-bytes',
        name: 'Work laptop',
      })
      .returning();
    return row;
  }

  it('records a rename with the passkey row id and no credential material', async () => {
    const user = await insertUser();
    const passkey = await insertPasskey(user.id);
    const caller = await createSessionCallerForUser(user.id);

    await caller.user.renamePasskey({ id: passkey.id, name: 'Home desktop' });

    const rows = await authRowsFor(user.id);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'auth.passkey.rename',
        outcome: 'success',
        user_id: user.id,
        method: 'session',
        failure_reason: null,
        metadata: { passkeyId: passkey.id },
      }),
    ]);
    const recorded = JSON.stringify({ rows, events });
    expect(recorded).not.toContain(passkey.credential_id);
    expect(recorded).not.toContain('cose-public-key-bytes');
    expect(recorded).not.toContain('Home desktop');
  });

  it('records a remove of a passkey the caller does not own as a not_found failure', async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const passkey = await insertPasskey(owner.id);
    const caller = await createSessionCallerForUser(other.id);

    await expect(caller.user.deletePasskey({ id: passkey.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(await authRowsFor(other.id)).toEqual([
      expect.objectContaining({
        action: 'auth.passkey.remove',
        outcome: 'failure',
        user_id: other.id,
        method: 'session',
        failure_reason: 'not_found',
        metadata: { passkeyId: passkey.id },
      }),
    ]);
  });

  it('records a remove by an app session without a management grant with the grant refusal', async () => {
    const user = await insertUser();
    const passkey = await insertPasskey(user.id);
    const sessionId = await insertDeviceSession(user.id);
    const caller = await createCallerForUser(user.id, { deviceSessionId: sessionId });

    await expect(caller.user.deletePasskey({ id: passkey.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(await authRowsFor(user.id)).toEqual([
      expect.objectContaining({
        action: 'auth.passkey.remove',
        outcome: 'failure',
        failure_reason: 'passkey_management_device_unsupported',
      }),
    ]);
  });
});
