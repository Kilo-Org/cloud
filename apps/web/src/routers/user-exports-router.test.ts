import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { user_data_exports, type User } from '@kilocode/db/schema';
import { createCallerForUser } from '@/routers/test-utils';
import { __test__ } from '@/routers/user-exports-router';
import { insertTestUser } from '@/tests/helpers/user.helper';

let owner: User;
let stranger: User;

beforeAll(async () => {
  owner = await insertTestUser({
    google_user_email: 'data-export-owner@admin.example.com',
    is_admin: true,
  });
  stranger = await insertTestUser({ google_user_email: 'data-export-stranger@example.com' });
});

afterEach(async () => {
  await db.delete(user_data_exports).where(eq(user_data_exports.kilo_user_id, owner.id));
  await db.delete(user_data_exports).where(eq(user_data_exports.kilo_user_id, stranger.id));
});

describe('user exports router guards and serialization', () => {
  it('rejects API-token authentication for data export procedures', () => {
    expect(() => __test__.requireWebSession(true)).toThrow(TRPCError);
    expect(() => __test__.requireWebSession(false)).not.toThrow();
  });

  it('rejects non-admin users', async () => {
    const caller = await createCallerForUser(stranger.id);
    await expect(caller.userExports.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('normalizes database timestamp text into strict UTC ISO strings', () => {
    expect(
      __test__.serialize({
        id: 'f477a317-7f63-4ab0-b5cc-0066b8b7478d',
        status: 'ready',
        requested_at: '2026-08-08 12:00:00+00',
        started_at: null,
        completed_at: '2026-08-08 12:01:00+00',
        expires_at: '2026-08-15 12:01:00+00',
        size_bytes: '2048',
        row_count: 42,
        failure_message: null,
        dispatch_generation: 0,
      })
    ).toMatchObject({
      requestedAt: '2026-08-08T12:00:00.000Z',
      sizeBytes: 2048,
      rowCount: 42,
    });
  });

  it('lists only exports owned by the authenticated user', async () => {
    await db.insert(user_data_exports).values([
      { kilo_user_id: owner.id, snapshot_at: new Date().toISOString() },
      { kilo_user_id: stranger.id, snapshot_at: new Date().toISOString() },
    ]);

    const caller = await createCallerForUser(owner.id);
    const result = await caller.userExports.list();

    expect(result.exports).toHaveLength(1);
    const [row] = await db
      .select({ id: user_data_exports.id })
      .from(user_data_exports)
      .where(eq(user_data_exports.kilo_user_id, owner.id));
    expect(result.exports[0]?.id).toBe(row.id);
  });

  it('uses the fixed August 3 UTC data cutoff for new exports', async () => {
    const caller = await createCallerForUser(owner.id);

    const requested = await caller.userExports.request();
    const [row] = await db
      .select({ snapshotAt: user_data_exports.snapshot_at })
      .from(user_data_exports)
      .where(eq(user_data_exports.id, requested.id));

    expect(new Date(row.snapshotAt).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('does not authorize another user or an expired export for download', async () => {
    const [ready] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: stranger.id,
        snapshot_at: new Date().toISOString(),
        status: 'ready',
        r2_object_key: `exports/${crypto.randomUUID()}/export.jsonl.gz`,
        size_bytes: 1,
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .returning();
    const [expired] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: owner.id,
        snapshot_at: new Date().toISOString(),
        status: 'ready',
        r2_object_key: `exports/${crypto.randomUUID()}/export.jsonl.gz`,
        size_bytes: 1,
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .returning();
    const caller = await createCallerForUser(owner.id);

    await expect(caller.userExports.createDownload({ exportId: ready.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller.userExports.createDownload({ exportId: expired.id })).rejects.toMatchObject(
      { code: 'NOT_FOUND' }
    );
  });
});
