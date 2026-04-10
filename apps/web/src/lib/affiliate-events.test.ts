import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kilocode_users,
  user_affiliate_attributions,
  user_affiliate_events,
} from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';

const originalFetch = global.fetch;

describe('affiliate-events', () => {
  beforeEach(() => {
    process.env.IMPACT_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_AUTH_TOKEN = 'impact-auth-token';
    process.env.IMPACT_CAMPAIGN_ID = '50754';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    await db.delete(user_affiliate_events).where(sql`true`);
    await db.delete(user_affiliate_attributions).where(sql`true`);
    await db.delete(kilocode_users).where(sql`true`);
  });

  it('dedupe keys prevent duplicate parent and child rows', async () => {
    const user = await insertTestUser();
    const {
      buildAffiliateEventDedupeKey,
      enqueueAffiliateEventForUser,
      recordAffiliateAttributionAndQueueParentEvent,
    } = await import('@/lib/affiliate-events');

    await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });
    await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });

    const childDedupeKey = buildAffiliateEventDedupeKey({
      provider: 'impact',
      eventType: 'trial_start',
      entityId: 'trial-subscription-1',
    });
    await enqueueAffiliateEventForUser({
      userId: user.id,
      provider: 'impact',
      eventType: 'trial_start',
      dedupeKey: childDedupeKey,
      eventDate: new Date('2026-04-09T10:05:00.000Z'),
      orderId: 'IR_AN_64_TS',
    });
    await enqueueAffiliateEventForUser({
      userId: user.id,
      provider: 'impact',
      eventType: 'trial_start',
      dedupeKey: childDedupeKey,
      eventDate: new Date('2026-04-09T10:05:00.000Z'),
      orderId: 'IR_AN_64_TS',
    });

    const rows = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.event_type === 'signup')).toHaveLength(1);
    expect(rows.filter(row => row.event_type === 'trial_start')).toHaveLength(1);
    expect(rows.find(row => row.event_type === 'trial_start')?.delivery_state).toBe('blocked');
  });

  it('delivers a parent event before its blocked child and unblocks the child in the same cron run', async () => {
    const user = await insertTestUser();
    const {
      buildAffiliateEventDedupeKey,
      dispatchQueuedAffiliateEvents,
      enqueueAffiliateEventForUser,
      recordAffiliateAttributionAndQueueParentEvent,
    } = await import('@/lib/affiliate-events');

    await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });
    await enqueueAffiliateEventForUser({
      userId: user.id,
      provider: 'impact',
      eventType: 'trial_start',
      dedupeKey: buildAffiliateEventDedupeKey({
        provider: 'impact',
        eventType: 'trial_start',
        entityId: 'trial-subscription-2',
      }),
      eventDate: new Date('2026-04-09T10:05:00.000Z'),
      orderId: 'IR_AN_64_TS',
    });

    const fetchMock: typeof fetch = jest.fn(async () => new Response('', { status: 200 }));
    global.fetch = fetchMock;

    const summary = await dispatchQueuedAffiliateEvents();
    const rows = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(summary).toEqual({
      reclaimed: 0,
      claimed: 2,
      delivered: 2,
      retried: 0,
      failed: 0,
      unblocked: 1,
    });
    expect(rows.map(row => row.delivery_state).sort()).toEqual(['delivered', 'delivered']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('requeues 5xx failures with backoff', async () => {
    const user = await insertTestUser();
    const { dispatchQueuedAffiliateEvents, recordAffiliateAttributionAndQueueParentEvent } =
      await import('@/lib/affiliate-events');

    await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });

    const fetchMock: typeof fetch = jest.fn(
      async () => new Response('upstream unavailable', { status: 503 })
    );
    global.fetch = fetchMock;

    const summary = await dispatchQueuedAffiliateEvents();
    const [row] = await db
      .select()
      .from(user_affiliate_events)
      .where(
        and(
          eq(user_affiliate_events.user_id, user.id),
          eq(user_affiliate_events.event_type, 'signup')
        )
      );

    expect(summary.retried).toBe(1);
    expect(row?.delivery_state).toBe('queued');
    expect(row?.attempt_count).toBe(1);
    expect(row?.claimed_at).toBeNull();
    expect(row?.next_retry_at).not.toBeNull();
  });

  it('marks 4xx failures as failed', async () => {
    const user = await insertTestUser();
    const { dispatchQueuedAffiliateEvents, recordAffiliateAttributionAndQueueParentEvent } =
      await import('@/lib/affiliate-events');

    await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });

    const fetchMock: typeof fetch = jest.fn(
      async () => new Response('bad request', { status: 400 })
    );
    global.fetch = fetchMock;

    const summary = await dispatchQueuedAffiliateEvents();
    const [row] = await db
      .select()
      .from(user_affiliate_events)
      .where(
        and(
          eq(user_affiliate_events.user_id, user.id),
          eq(user_affiliate_events.event_type, 'signup')
        )
      );

    expect(summary.failed).toBe(1);
    expect(row?.delivery_state).toBe('failed');
    expect(row?.attempt_count).toBe(1);
    expect(row?.claimed_at).toBeNull();
  });

  it('reclaims stale sending rows before dispatching', async () => {
    const user = await insertTestUser();
    const { dispatchQueuedAffiliateEvents, recordAffiliateAttributionAndQueueParentEvent } =
      await import('@/lib/affiliate-events');

    const parentEvent = await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });

    expect(parentEvent).not.toBeNull();

    await db
      .update(user_affiliate_events)
      .set({
        delivery_state: 'sending',
        claimed_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      })
      .where(eq(user_affiliate_events.id, parentEvent!.id));

    const fetchMock: typeof fetch = jest.fn(async () => new Response('', { status: 200 }));
    global.fetch = fetchMock;

    const summary = await dispatchQueuedAffiliateEvents();
    const [row] = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.id, parentEvent!.id));

    expect(summary.reclaimed).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(row?.delivery_state).toBe('delivered');
  });
});
