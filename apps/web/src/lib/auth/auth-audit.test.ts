import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { auth_audit_logs } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  authAuditEmailHash,
  recordAuthEvent,
  setAuthActionSinkForTest,
  type AuthActionEvent,
} from '@/lib/auth/auth-audit';

const request = { ip: '203.0.113.9', route: '/api/auth/callback/google' };

let events: AuthActionEvent[];

beforeEach(() => {
  events = [];
  setAuthActionSinkForTest(event => events.push(event));
});

afterEach(async () => {
  setAuthActionSinkForTest(null);
  await cleanupDbForTest();
});

describe('authAuditEmailHash', () => {
  test('is a keyed, domain-separated hash of the normalized address', () => {
    const expected = createHmac('sha256', 'test-only-non-secret')
      .update('auth-audit-email:v1:someone@example.com')
      .digest('base64url');

    expect(authAuditEmailHash('  Someone+tag@Example.com ')).toBe(expected);
  });
});

describe('recordAuthEvent', () => {
  test('writes a failure row and log line that hold the email only as its hash', async () => {
    await recordAuthEvent(request, {
      action: 'auth.sign_in',
      outcome: 'failure',
      method: 'google',
      failureReason: 'account_blocked',
      email: 'Someone@Example.com',
    });

    const rows = await db.select().from(auth_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in',
        outcome: 'failure',
        user_id: null,
        method: 'google',
        failure_reason: 'account_blocked',
        subject_email_hash: authAuditEmailHash('someone@example.com'),
        metadata: null,
      }),
    ]);
    expect(events).toEqual([
      {
        event: 'auth_action',
        action: 'auth.sign_in',
        outcome: 'failure',
        userId: null,
        method: 'google',
        failureReason: 'account_blocked',
        auditLogId: rows[0]?.id,
        persisted: true,
        ip: '203.0.113.9',
        route: '/api/auth/callback/google',
      },
    ]);
    const recorded = JSON.stringify({ rows, events }).toLowerCase();
    expect(recorded).not.toContain('someone');
    expect(recorded).not.toContain('example.com');
  });

  test('replaces a failure reason that is not a stable code', async () => {
    await recordAuthEvent(request, {
      action: 'auth.passkey.add',
      outcome: 'failure',
      userId: 'user-1',
      failureReason: 'Verification failed for someone@example.com',
    });

    const [row] = await db.select().from(auth_audit_logs);
    expect(row?.failure_reason).toBe('invalid_code_value');
    expect(events[0]?.failureReason).toBe('invalid_code_value');
  });

  test('still emits the log line, flagged unpersisted, when the insert fails', async () => {
    const insert = jest.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    try {
      await expect(
        recordAuthEvent(request, { action: 'auth.sign_out', outcome: 'success', userId: 'user-1' })
      ).resolves.toBeUndefined();
    } finally {
      insert.mockRestore();
    }

    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.sign_out',
        outcome: 'success',
        userId: 'user-1',
        auditLogId: null,
        persisted: false,
      }),
    ]);
  });
});
