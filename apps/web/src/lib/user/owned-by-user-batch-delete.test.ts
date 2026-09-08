import { eq } from 'drizzle-orm';
import { cloud_agent_code_reviews, webhook_events } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  deleteAllOwnedByUserIdPages,
  deleteOwnedByUserIdPage,
} from '@/lib/user/owned-by-user-batch-delete';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('owned-by-user batch delete', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('deletes at most one page of webhook events and leaves other users untouched', async () => {
    const user = await insertTestUser({
      google_user_email: `batch-owner-${crypto.randomUUID()}@example.com`,
    });
    const other = await insertTestUser({
      google_user_email: `batch-other-${crypto.randomUUID()}@example.com`,
    });
    await insertWebhookEvents(user.id, 3);
    await insertWebhookEvents(other.id, 1);

    const deleted = await db.transaction(tx =>
      deleteOwnedByUserIdPage(tx, 'webhook_events', user.id, 2)
    );

    expect(deleted).toBe(2);
    expect(await countOwnedWebhookEvents(user.id)).toBe(1);
    expect(await countOwnedWebhookEvents(other.id)).toBe(1);
  });

  it('drains every page of code reviews for the target user', async () => {
    const user = await insertTestUser({
      google_user_email: `batch-reviews-${crypto.randomUUID()}@example.com`,
    });
    await insertCodeReviews(user.id, 3);

    await db.transaction(tx => deleteAllOwnedByUserIdPages(tx, 'cloud_agent_code_reviews', user.id, 2));

    expect(await countOwnedCodeReviews(user.id)).toBe(0);
  });
});

async function insertWebhookEvents(userId: string, count: number): Promise<void> {
  await db.insert(webhook_events).values(
    Array.from({ length: count }, (_, index) => ({
      owned_by_user_id: userId,
      platform: 'github',
      event_type: 'push',
      event_action: 'created',
      payload: { index },
      headers: {},
      event_signature: `sig-${userId}-${index}-${crypto.randomUUID()}`,
    }))
  );
}

async function insertCodeReviews(userId: string, count: number): Promise<void> {
  await db.insert(cloud_agent_code_reviews).values(
    Array.from({ length: count }, (_, index) => {
      const id = crypto.randomUUID();
      return {
        id,
        owned_by_user_id: userId,
        repo_full_name: `batch-test/repo-${id}`,
        pr_number: index + 1,
        pr_url: `https://example.com/batch-test/repo-${id}/pull/${index + 1}`,
        pr_title: 'Test PR',
        pr_author: 'author',
        base_ref: 'main',
        head_ref: `feature-${id}`,
        head_sha: id.replaceAll('-', ''),
        platform: 'github' as const,
        status: 'completed',
      };
    })
  );
}

async function countOwnedWebhookEvents(userId: string): Promise<number> {
  const rows = await db
    .select({ id: webhook_events.id })
    .from(webhook_events)
    .where(eq(webhook_events.owned_by_user_id, userId));
  return rows.length;
}

async function countOwnedCodeReviews(userId: string): Promise<number> {
  const rows = await db
    .select({ id: cloud_agent_code_reviews.id })
    .from(cloud_agent_code_reviews)
    .where(eq(cloud_agent_code_reviews.owned_by_user_id, userId));
  return rows.length;
}
