import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));

import { and, eq } from 'drizzle-orm';
import { auth_audit_logs } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { setAuthActionSinkForTest, type AuthActionEvent } from '@/lib/auth/auth-audit';
import { POST } from './route';

const mockAuth = jest.mocked(getUserFromAuth);

let events: AuthActionEvent[];

beforeEach(() => {
  events = [];
  setAuthActionSinkForTest(event => events.push(event));
});

afterEach(() => {
  setAuthActionSinkForTest(null);
});

function revokeRequest() {
  return new Request(`${APP_URL}/api/auth/revoke-web-session`, { method: 'POST' });
}

describe('POST /api/auth/revoke-web-session audit', () => {
  it('records a sign-out with no session as the log line only', async () => {
    mockAuth.mockResolvedValue({ user: null, authFailedResponse: null } as never);

    const response = await POST(revokeRequest());

    expect(response.status).toBe(200);
    expect(
      await db
        .select()
        .from(auth_audit_logs)
        .where(
          and(
            eq(auth_audit_logs.action, 'auth.sign_out'),
            eq(auth_audit_logs.failure_reason, 'no_session')
          )
        )
    ).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.sign_out',
        outcome: 'failure',
        userId: null,
        failureReason: 'no_session',
        stored: false,
        persisted: false,
        route: '/api/auth/revoke-web-session',
      }),
    ]);
  });

  it('records a sign-out of a session as a row', async () => {
    const user = await insertTestUser();
    mockAuth.mockResolvedValue({ user, authFailedResponse: null } as never);

    expect((await POST(revokeRequest())).status).toBe(200);

    expect(
      await db.select().from(auth_audit_logs).where(eq(auth_audit_logs.user_id, user.id))
    ).toEqual([
      expect.objectContaining({ action: 'auth.sign_out', outcome: 'success', method: 'web' }),
    ]);
    expect(events).toEqual([expect.objectContaining({ stored: true, persisted: true })]);
  });
});
