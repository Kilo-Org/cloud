import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { app_builder_feedback } from '@kilocode/db/schema';
import { inArray, eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';

let regularUser: User;
let otherUser: User;

async function cleanupFeedback() {
  await db
    .delete(app_builder_feedback)
    .where(inArray(app_builder_feedback.kilo_user_id, [regularUser.id, otherUser.id]));
}

beforeAll(async () => {
  regularUser = await insertTestUser({
    google_user_email: 'app-builder-feedback-history-user@example.com',
    google_user_name: 'App Builder Feedback History User',
    is_admin: false,
  });
  otherUser = await insertTestUser({
    google_user_email: 'app-builder-feedback-history-other@example.com',
    google_user_name: 'App Builder Feedback History Other',
    is_admin: false,
  });
  await cleanupFeedback();
});

afterEach(cleanupFeedback);

describe('appBuilderFeedback.list', () => {
  it("returns only the caller's own feedback, newest first", async () => {
    await db.insert(app_builder_feedback).values([
      {
        kilo_user_id: regularUser.id,
        feedback_text: 'older submission',
        created_at: '2026-01-01 00:00:00.000+00',
      },
      {
        kilo_user_id: regularUser.id,
        feedback_text: 'newer submission',
        created_at: '2026-02-01 00:00:00.000+00',
      },
      {
        kilo_user_id: otherUser.id,
        feedback_text: 'someone else',
        created_at: '2026-03-01 00:00:00.000+00',
      },
    ]);

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.appBuilderFeedback.list();

    expect(result.map(row => row.feedback_text)).toEqual(['newer submission', 'older submission']);
  });

  it('defaults to the five newest submissions', async () => {
    await db.insert(app_builder_feedback).values(
      Array.from({ length: 6 }, (_, index) => ({
        kilo_user_id: regularUser.id,
        feedback_text: `submission ${index}`,
        created_at: `2026-01-0${index + 1} 00:00:00.000+00`,
      }))
    );

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.appBuilderFeedback.list();

    expect(result.map(row => row.feedback_text)).toEqual([
      'submission 5',
      'submission 4',
      'submission 3',
      'submission 2',
      'submission 1',
    ]);
  });

  it('returns ISO timestamps without internal context fields', async () => {
    await db.insert(app_builder_feedback).values({
      kilo_user_id: regularUser.id,
      feedback_text: 'shaped submission',
      session_id: 'session_123',
      model: 'test-model',
      preview_status: 'ready',
      recent_messages: [{ role: 'user', text: 'hello', ts: 1 }],
      created_at: '2026-01-01 00:00:00.000+00',
    });

    const caller = await createCallerForUser(regularUser.id);
    const [row] = await caller.appBuilderFeedback.list();

    expect(row?.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(row).not.toHaveProperty('recent_messages');
    expect(row).not.toHaveProperty('session_id');
  });

  it('honours an explicit limit', async () => {
    await db.insert(app_builder_feedback).values(
      Array.from({ length: 3 }, (_, index) => ({
        kilo_user_id: regularUser.id,
        feedback_text: `limited ${index}`,
        created_at: `2026-01-0${index + 1} 00:00:00.000+00`,
      }))
    );

    const caller = await createCallerForUser(regularUser.id);
    const result = await caller.appBuilderFeedback.list({ limit: 2 });

    expect(result.map(row => row.feedback_text)).toEqual(['limited 2', 'limited 1']);
  });

  it('accepts the maximum limit and rejects out-of-range input', async () => {
    await db.insert(app_builder_feedback).values(
      Array.from({ length: 25 }, (_, index) => ({
        kilo_user_id: regularUser.id,
        feedback_text: `capped ${index}`,
        // Distinct, increasing instants so the cap is observable.
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }))
    );

    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.appBuilderFeedback.list({ limit: 20 })).resolves.toHaveLength(20);
    await expect(caller.appBuilderFeedback.list({ limit: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.appBuilderFeedback.list({ limit: 1.5 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects a limit above the maximum', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.appBuilderFeedback.list({ limit: 21 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('returns an empty list for a user with no feedback', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.appBuilderFeedback.list()).resolves.toEqual([]);
  });

  it('excludes orphaned rows whose owning user was deleted', async () => {
    const [orphan] = await db
      .insert(app_builder_feedback)
      .values({
        kilo_user_id: null,
        feedback_text: 'orphaned owner',
        created_at: '2026-02-01 00:00:00.000+00',
      })
      .returning({ id: app_builder_feedback.id });

    try {
      await db.insert(app_builder_feedback).values({
        kilo_user_id: regularUser.id,
        feedback_text: 'kept',
        created_at: '2026-01-01 00:00:00.000+00',
      });

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.appBuilderFeedback.list();

      expect(result.map(row => row.feedback_text)).toEqual(['kept']);
    } finally {
      await db.delete(app_builder_feedback).where(eq(app_builder_feedback.id, orphan.id));
    }
  });
});
