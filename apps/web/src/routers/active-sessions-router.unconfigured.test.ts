import { describe, expect, it, jest, beforeAll, afterEach } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { createCallerForUser } from '@/routers/test-utils';

// `.env.test` leaves SESSION_INGEST_WORKER_URL empty. This file keeps that
// value; the sibling router test sets a URL before its first import.

let user: User;

describe('active-sessions-router without a Session Ingest URL', () => {
  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'active-sessions-unconfigured@example.com',
      google_user_name: 'Active Sessions Unconfigured',
      is_admin: false,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws PRECONDITION_FAILED without calling the worker', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const caller = await createCallerForUser(user.id);

    const error = await caller.activeSessions.createWebTicket().then(
      () => undefined,
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Session ingest is not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
