import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { user_notification_history } from '@kilocode/db/schema';
import { NOTIFICATION_HISTORY_RETENTION_MS } from '@kilocode/notifications';
import { eq } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;

async function insertHistory(
  userId: string,
  over: Partial<typeof user_notification_history.$inferInsert> = {}
) {
  const [row] = await db
    .insert(user_notification_history)
    .values({
      user_id: userId,
      category: 'chatMessages',
      push_type: 'chat.message',
      payload: { type: 'chat.message', sandboxId: 'sb', conversationId: 'c', messageId: 'm' },
      i18n_key: 'chat.message',
      i18n_params: { conversationTitle: 'Hello' },
      fallback_title: 'Kilo',
      fallback_body: 'New message',
      idempotency_key: `idem-${crypto.randomUUID()}`,
      dedupe_bucket: Math.floor(Date.now() / 3_600_000),
      ...over,
    })
    .returning();
  return row;
}

const iso = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();

describe('user.getNotificationHistory', () => {
  it('returns the newest rows first, in pages with a working cursor', async () => {
    const user = await insertTestUser();
    const newest = await insertHistory(user.id, {
      created_at: iso(1 * 60 * 1000),
      idempotency_key: 'page-newest',
    });
    const middle = await insertHistory(user.id, {
      created_at: iso(2 * 60 * 1000),
      idempotency_key: 'page-middle',
    });
    const oldest = await insertHistory(user.id, {
      created_at: iso(3 * 60 * 1000),
      idempotency_key: 'page-oldest',
    });

    const caller = await createCallerForUser(user.id);
    const first = await caller.user.getNotificationHistory({ limit: 2 });

    expect(first.items.map(item => item.id)).toEqual([newest.id, middle.id]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items[0]).toMatchObject({
      category: 'chatMessages',
      pushType: 'chat.message',
      i18nKey: 'chat.message',
      i18nParams: { conversationTitle: 'Hello' },
      title: 'Kilo',
      body: 'New message',
      payload: { type: 'chat.message', sandboxId: 'sb', conversationId: 'c', messageId: 'm' },
    });
    expect(new Date(first.items[0].createdAt).toISOString()).toBe(first.items[0].createdAt);

    const second = await caller.user.getNotificationHistory({
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map(item => item.id)).toEqual([oldest.id]);
    expect(second.nextCursor).toBeNull();
  });

  it('resumes after the cursor row when rows share a timestamp', async () => {
    const user = await insertTestUser();
    const shared = iso(5 * 60 * 1000);
    const first = await insertHistory(user.id, { created_at: shared, idempotency_key: 'tie-a' });
    const second = await insertHistory(user.id, { created_at: shared, idempotency_key: 'tie-b' });
    const expected = [first.id, second.id].sort().reverse();

    const caller = await createCallerForUser(user.id);
    const page1 = await caller.user.getNotificationHistory({ limit: 1 });
    expect(page1.items.map(item => item.id)).toEqual([expected[0]]);
    const page2 = await caller.user.getNotificationHistory({
      limit: 1,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.map(item => item.id)).toEqual([expected[1]]);
  });

  it('still resolves a cursor whose row was deleted by the prune', async () => {
    const user = await insertTestUser();
    const newer = await insertHistory(user.id, {
      created_at: iso(10 * 60 * 1000),
      idempotency_key: 'prune-newer',
    });
    const middle = await insertHistory(user.id, {
      created_at: iso(11 * 60 * 1000),
      idempotency_key: 'prune-middle',
    });
    const oldest = await insertHistory(user.id, {
      created_at: iso(12 * 60 * 1000),
      idempotency_key: 'prune-oldest',
    });

    const caller = await createCallerForUser(user.id);
    const page1 = await caller.user.getNotificationHistory({ limit: 2 });
    expect(page1.items.map(item => item.id)).toEqual([newer.id, middle.id]);

    // The prune deletes a row behind the cursor while a client still holds it.
    await db.delete(user_notification_history).where(eq(user_notification_history.id, middle.id));

    const page2 = await caller.user.getNotificationHistory({
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.map(item => item.id)).toEqual([oldest.id]);
    expect(page2.items.map(item => item.id)).not.toContain(middle.id);
  });

  it('filters by category and returns an empty page for a category with no rows', async () => {
    const user = await insertTestUser();
    await insertHistory(user.id, { category: 'chatMessages', created_at: iso(60 * 1000) });
    const balance = await insertHistory(user.id, {
      category: 'balanceAlerts',
      push_type: 'low_balance',
      created_at: iso(2 * 60 * 1000),
    });

    const caller = await createCallerForUser(user.id);
    const filtered = await caller.user.getNotificationHistory({ category: 'balanceAlerts' });
    expect(filtered.items.map(item => item.id)).toEqual([balance.id]);

    const empty = await caller.user.getNotificationHistory({ category: 'securityFindings' });
    expect(empty).toEqual({ items: [], nextCursor: null });
  });

  it('keeps briefings in the unfiltered list under no category', async () => {
    const user = await insertTestUser();
    const briefing = await insertHistory(user.id, {
      category: null,
      push_type: 'agent_briefing',
      created_at: iso(60 * 1000),
    });

    const caller = await createCallerForUser(user.id);
    const all = await caller.user.getNotificationHistory({});
    expect(all.items.map(item => item.id)).toEqual([briefing.id]);
    expect(all.items[0]?.category).toBeNull();
  });

  it('hides rows outside the retention window', async () => {
    const user = await insertTestUser();
    const inside = await insertHistory(user.id, {
      created_at: iso(NOTIFICATION_HISTORY_RETENTION_MS - DAY_MS),
      idempotency_key: 'window-inside',
    });
    await insertHistory(user.id, {
      created_at: iso(NOTIFICATION_HISTORY_RETENTION_MS + DAY_MS),
      idempotency_key: 'window-outside',
    });

    const caller = await createCallerForUser(user.id);
    const page = await caller.user.getNotificationHistory({});
    expect(page.items.map(item => item.id)).toEqual([inside.id]);
  });

  it('records a later dispatch of the same key as its own row', async () => {
    const user = await insertTestUser();
    const bucket = Math.floor(Date.now() / 3_600_000);
    const shared = {
      idempotency_key: 'low-balance:org-repeat',
      category: 'balanceAlerts',
      push_type: 'low_balance',
    };

    // A retry of one dispatch (same acceptance hour) hits the unique index.
    await insertHistory(user.id, { ...shared, dedupe_bucket: bucket });
    const retry = await insertHistory(user.id, { ...shared, dedupe_bucket: bucket }).catch(
      () => null
    );
    expect(retry).toBeNull();

    // A later crossing of the same threshold is a new dispatch instance.
    await insertHistory(user.id, { ...shared, dedupe_bucket: bucket + 3 });

    const caller = await createCallerForUser(user.id);
    const page = await caller.user.getNotificationHistory({ category: 'balanceAlerts' });
    expect(page.items.map(item => item.pushType)).toEqual(['low_balance', 'low_balance']);
  });

  it('never returns another account’s rows', async () => {
    const owner = await insertTestUser();
    const stranger = await insertTestUser();
    await insertHistory(owner.id, { created_at: iso(60 * 1000) });

    const caller = await createCallerForUser(stranger.id);
    expect(await caller.user.getNotificationHistory({})).toEqual({ items: [], nextCursor: null });
  });

  it('rejects a malformed cursor and an out-of-range limit', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.user.getNotificationHistory({ cursor: 'not-a-cursor' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.user.getNotificationHistory({ limit: 101 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
