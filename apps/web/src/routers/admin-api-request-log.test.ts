import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { api_request_log, kilocode_users } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

describe('admin.apiRequestLog.getSummary authorization', () => {
  const createdUserIds: string[] = [];

  async function createUser(overrides: Parameters<typeof insertTestUser>[0]) {
    const user = await insertTestUser(overrides);
    createdUserIds.push(user.id);
    return user;
  }

  afterEach(async () => {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
    createdUserIds.length = 0;
  });

  test('requires session viewing access', async () => {
    const nonAdmin = await createUser({});
    const admin = await createUser({ is_admin: true });

    await expect(
      (await createCallerForUser(nonAdmin.id)).admin.apiRequestLog.getSummary()
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Admin access required' });
    await expect(
      (await createCallerForUser(admin.id)).admin.apiRequestLog.getSummary()
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Session viewing access required' });
  });

  test('returns the summary to a session viewer', async () => {
    const viewer = await createUser({ is_admin: true, can_view_sessions: true });
    const ownerId = `api-request-log-summary-${crypto.randomUUID()}`;
    await db.insert(api_request_log).values({
      kilo_user_id: ownerId,
      provider: 'test-provider',
      model: 'test/model',
      created_at: '2026-08-01T12:00:00.000Z',
    });

    const summary = await (await createCallerForUser(viewer.id)).admin.apiRequestLog.getSummary();

    expect(summary.recordCount).toBeGreaterThan(0);
    expect(summary.sizeBytes).toBeGreaterThan(0);
    expect(summary.oldestCreatedAt).not.toBeNull();
    await db.delete(api_request_log).where(eq(api_request_log.kilo_user_id, ownerId));
  });
});
