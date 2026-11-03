jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { query: { kilocode_users: { findFirst: jest.fn() } } },
}));

import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { requireWorkerAdminActor, WorkerAdminActorError } from './actor-guard';

const findFirst = jest.mocked(db.query.kilocode_users.findFirst);
const getSession = jest.mocked(getUserFromSessionForCredentialIssuance);

const admin = {
  id: 'user-1',
  google_user_email: 'admin@example.com',
  is_admin: true,
  is_super_admin: false,
  api_token_pepper: 'pepper-1',
  blocked_at: null,
};

const requirement = {
  actionClass: 'worker_admin' as const,
  target: { kind: 'service' as const, id: 'gastown' },
  inventoryId: 'rest.gastownToken',
};

function expectActorError(error: unknown, code: string, status: number) {
  expect(error).toBeInstanceOf(WorkerAdminActorError);
  expect(error).toMatchObject({ code, status });
}

beforeEach(() => {
  findFirst.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ user: { id: 'user-1' } } as never);
  findFirst.mockResolvedValue(admin as never);
});

describe('requireWorkerAdminActor (interim adapter)', () => {
  it('refuses bearer credentials before reading the session', async () => {
    const error = await requireWorkerAdminActor(
      null,
      new Headers({ Authorization: 'Bearer personal-api-key' }),
      requirement
    ).catch((caught: unknown) => caught);
    expectActorError(error, 'session_required', 401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('requires a session', async () => {
    getSession.mockResolvedValue({ user: null } as never);
    const error = await requireWorkerAdminActor(null, new Headers(), requirement).catch(
      (caught: unknown) => caught
    );
    expectActorError(error, 'authentication_required', 401);
  });

  it('re-reads the primary and rejects a blocked user', async () => {
    findFirst.mockResolvedValue({ ...admin, blocked_at: new Date() } as never);
    const error = await requireWorkerAdminActor(null, new Headers(), requirement).catch(
      (caught: unknown) => caught
    );
    expectActorError(error, 'blocked', 403);
  });

  it('re-reads the primary and rejects a demoted user', async () => {
    findFirst.mockResolvedValue({ ...admin, is_admin: false } as never);
    const error = await requireWorkerAdminActor(null, new Headers(), requirement).catch(
      (caught: unknown) => caught
    );
    expectActorError(error, 'not_admin', 403);
  });

  it('always fails closed until PR2 provides a fresh step-up', async () => {
    const error = await requireWorkerAdminActor(null, new Headers(), requirement).catch(
      (caught: unknown) => caught
    );
    expectActorError(error, 'step_up_required', 403);
  });
});
