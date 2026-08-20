import { sql } from 'drizzle-orm';
import { user_deletion_requests } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { inspectDeletionTargets } from '@/lib/user/deletion-queue/deletion-preview';
import { DeletionRefusalCode } from '@/lib/user/deletion-queue/deletion-intake';
import { insertTestUser } from '@/tests/helpers/user.helper';

async function deletionRequestCount(): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(user_deletion_requests);
  return count;
}

describe('inspectDeletionTargets', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects the actor email as protected_self and allows another admin', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const actor = await insertTestUser({
      google_user_email: 'inspect-self@example.com',
      is_admin: true,
    });
    const otherAdmin = await insertTestUser({
      google_user_email: 'inspect-other-admin@example.com',
      is_admin: true,
    });
    const before = await deletionRequestCount();

    const selfResult = await inspectDeletionTargets([{ email: actor.google_user_email }], {
      id: actor.id,
      email: actor.google_user_email,
    });
    const otherResult = await inspectDeletionTargets([{ email: otherAdmin.google_user_email }], {
      id: actor.id,
      email: actor.google_user_email,
    });

    expect(selfResult.accepted).toEqual([]);
    expect(selfResult.rejected).toEqual([
      {
        ok: false,
        email: 'inspect-self@example.com',
        pylonTicket: null,
        code: DeletionRefusalCode.ProtectedSelf,
      },
    ]);
    expect(otherResult.rejected).toEqual([]);
    expect(otherResult.accepted).toEqual([
      {
        ok: true,
        email: 'inspect-other-admin@example.com',
        pylonTicket: null,
        warnings: [],
        userId: otherAdmin.id,
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await deletionRequestCount()).toBe(before);
  });

  it('rejects an already-enqueued email as already_active', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const actor = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ google_user_email: 'inspect-active@example.com' });
    const [enqueued] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: actor.id },
      targets: [{ email: user.google_user_email, trustedUserId: user.id }],
    });
    expect(enqueued.status).toBe('enqueued');
    const before = await deletionRequestCount();

    const result = await inspectDeletionTargets([{ email: 'inspect-active@example.com' }]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      {
        ok: false,
        email: 'inspect-active@example.com',
        pylonTicket: null,
        code: DeletionRefusalCode.AlreadyActive,
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await deletionRequestCount()).toBe(before);
  });

  it('rejects an already-enqueued Pylon ticket as ticket_already_active', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const first = await insertTestUser({ google_user_email: 'inspect-ticket-one@example.com' });
    const second = await insertTestUser({ google_user_email: 'inspect-ticket-two@example.com' });
    const [enqueued] = await enqueueUserDeletionTargets({
      actor: { kiloUserId: actor.id },
      targets: [
        { email: first.google_user_email, pylonTicket: '#iss-shared', trustedUserId: first.id },
      ],
    });
    expect(enqueued.status).toBe('enqueued');

    const result = await inspectDeletionTargets([
      { email: second.google_user_email, pylonTicket: 'iss-shared' },
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      {
        ok: false,
        email: 'inspect-ticket-two@example.com',
        pylonTicket: 'iss-shared',
        code: DeletionRefusalCode.TicketAlreadyActive,
      },
    ]);
  });

  it('accepts a normal user with userId set', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const user = await insertTestUser({ google_user_email: 'inspect-normal@example.com' });
    const before = await deletionRequestCount();

    const result = await inspectDeletionTargets([
      { email: '  Inspect-Normal@Example.com ', pylonTicket: '#44' },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([
      {
        ok: true,
        email: 'inspect-normal@example.com',
        pylonTicket: '#44',
        warnings: [],
        userId: user.id,
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await deletionRequestCount()).toBe(before);
  });

  it('resolves a ticket-only entry from the Pylon requester email', async () => {
    process.env.PYLON_API_KEY = 'test-pylon-key';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: { id: 'iss_1', requester: { email: 'From-Ticket@Example.com' } } }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    const user = await insertTestUser({ google_user_email: 'from-ticket@example.com' });

    const result = await inspectDeletionTargets([{ pylonTicket: '#5678' }]);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([
      {
        ok: true,
        email: 'from-ticket@example.com',
        pylonTicket: '#5678',
        warnings: [],
        userId: user.id,
      },
    ]);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('rejects a ticket-only entry when Pylon has no requester email', async () => {
    process.env.PYLON_API_KEY = 'test-pylon-key';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'iss_1', requester: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await inspectDeletionTargets([{ pylonTicket: '#5678' }]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      {
        ok: false,
        email: '',
        pylonTicket: '#5678',
        code: DeletionRefusalCode.TicketUnresolved,
      },
    ]);
  });

  it('rejects an unknown email as no_cloud_user', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const before = await deletionRequestCount();

    const result = await inspectDeletionTargets([{ email: 'inspect-missing@example.com' }]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      {
        ok: false,
        email: 'inspect-missing@example.com',
        pylonTicket: null,
        code: DeletionRefusalCode.NoCloudUser,
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await deletionRequestCount()).toBe(before);
  });
});
