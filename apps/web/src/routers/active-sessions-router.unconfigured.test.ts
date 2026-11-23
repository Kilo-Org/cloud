import { describe, expect, it, jest, beforeAll, afterEach } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { createCallerForUser } from '@/routers/test-utils';

// `.env.test` leaves SESSION_INGEST_WORKER_URL empty. This file keeps that
// value; the sibling router test sets a URL before its first import.

let user: User;

async function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => undefined,
    (rejection: unknown) => rejection
  );
}

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

  it('throws PRECONDITION_FAILED from createWebTicket without calling the worker', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const caller = await createCallerForUser(user.id);

    const error = await rejectionOf(() => caller.activeSessions.createWebTicket());

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Session ingest is not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws PRECONDITION_FAILED from listInstances without calling the worker', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const caller = await createCallerForUser(user.id);

    const error = await rejectionOf(() => caller.activeSessions.listInstances());

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Session ingest is not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports the same code for both procedures when the URL is missing', async () => {
    const caller = await createCallerForUser(user.id);

    const mintRejection = await rejectionOf(() => caller.activeSessions.createWebTicket());
    const listRejection = await rejectionOf(() => caller.activeSessions.listInstances());

    expect(mintRejection).toBeInstanceOf(TRPCError);
    expect(listRejection).toBeInstanceOf(TRPCError);
    if (!(mintRejection instanceof TRPCError) || !(listRejection instanceof TRPCError)) return;
    expect(listRejection.code).toBe(mintRejection.code);
  });
});
