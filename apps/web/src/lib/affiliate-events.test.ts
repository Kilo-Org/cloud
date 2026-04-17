import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kilocode_users,
  pending_impact_sale_reversals,
  user_affiliate_attributions,
  user_affiliate_events,
} from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';

const originalFetch = global.fetch;

describe('affiliate-events', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.IMPACT_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_AUTH_TOKEN = 'impact-auth-token';
    process.env.IMPACT_CAMPAIGN_ID = '50754';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    await db.delete(pending_impact_sale_reversals).where(sql`true`);
    await db.delete(user_affiliate_events).where(sql`true`);
    await db.delete(user_affiliate_attributions).where(sql`true`);
    await db.delete(kilocode_users).where(sql`true`);
  });

  async function markParentDelivered(parentEventId: string) {
    await db
      .update(user_affiliate_events)
      .set({
        delivery_state: 'delivered',
        claimed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
        next_retry_at: null,
      })
      .where(eq(user_affiliate_events.id, parentEventId));
  }

  async function getUserAffiliateEvents(userId: string) {
    return await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, userId));
  }

  async function createQueuedSaleEvent(params?: { stripeChargeId?: string }) {
    const user = await insertTestUser();
    const stripeChargeId = params?.stripeChargeId ?? 'ch_sale_test_123';
    const {
      buildAffiliateEventDedupeKey,
      enqueueAffiliateEventForUser,
      recordAffiliateAttributionAndQueueParentEvent,
    } = await import('@/lib/affiliate-events');

    const parentEvent = await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });

    expect(parentEvent).not.toBeNull();
    await markParentDelivered(parentEvent!.id);

    await enqueueAffiliateEventForUser({
      userId: user.id,
      provider: 'impact',
      eventType: 'sale',
      dedupeKey: buildAffiliateEventDedupeKey({
        provider: 'impact',
        eventType: 'sale',
        entityId: `invoice-${stripeChargeId}`,
      }),
      eventDate: new Date('2026-04-09T10:05:00.000Z'),
      orderId: `invoice-${stripeChargeId}`,
      amount: 29,
      currencyCode: 'usd',
      itemCategory: 'kiloclaw-standard',
      itemName: 'KiloClaw Standard Plan',
      itemSku: 'price_standard',
      stripeChargeId,
    });

    const saleEvent = (await getUserAffiliateEvents(user.id)).find(
      row => row.event_type === 'sale'
    );
    expect(saleEvent).toBeDefined();

    return {
      user,
      saleEvent: saleEvent!,
    };
  }

  async function createDeliveredSaleEvent(params?: {
    stripeChargeId?: string;
    saleResponse?: 'immediate' | 'queued';
  }) {
    const stripeChargeId = params?.stripeChargeId ?? 'ch_sale_test_123';
    const { user } = await createQueuedSaleEvent({ stripeChargeId });
    const { dispatchQueuedAffiliateEvents } = await import('@/lib/affiliate-events');

    global.fetch = jest.fn().mockResolvedValue(
      params?.saleResponse === 'queued'
        ? new Response(
            JSON.stringify({
              Status: 'QUEUED',
              QueuedUri: '/Advertisers/impact-account-sid/APISubmissions/A-sale-queued',
            }),
            { status: 200 }
          )
        : new Response(
            JSON.stringify({
              ActionId: '1000.2000.3000',
              ActionUri: '/Advertisers/impact-account-sid/Actions/1000.2000.3000',
            }),
            { status: 200 }
          )
    ) as jest.MockedFunction<typeof fetch>;

    const summary = await dispatchQueuedAffiliateEvents();
    const saleEvent = (await getUserAffiliateEvents(user.id)).find(
      row => row.event_type === 'sale'
    );
    expect(saleEvent).toBeDefined();

    return {
      user,
      saleEvent: saleEvent!,
      summary,
    };
  }

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

  it('delivers a parent event before its blocked child and leaves the child queued until the processing gap passes', async () => {
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
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
      unblocked: 1,
    });
    expect(rows.map(row => row.delivery_state).sort()).toEqual(['delivered', 'queued']);
    expect(rows.find(row => row.event_type === 'signup')?.claimed_at).not.toBeNull();
    expect(rows.find(row => row.event_type === 'trial_start')?.claimed_at).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('dispatches a child immediately when the parent was delivered without a claimed_at timestamp', async () => {
    const user = await insertTestUser();
    const {
      buildAffiliateEventDedupeKey,
      dispatchQueuedAffiliateEvents,
      enqueueAffiliateEventForUser,
      recordAffiliateAttributionAndQueueParentEvent,
    } = await import('@/lib/affiliate-events');

    const parentEvent = await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });

    expect(parentEvent).not.toBeNull();

    // Simulate unconfigured delivery: parent is delivered with claimed_at cleared
    // (as happens when sendImpactConversionPayload returns skipped: 'unconfigured').
    await db
      .update(user_affiliate_events)
      .set({
        delivery_state: 'delivered',
        claimed_at: null,
        next_retry_at: null,
      })
      .where(eq(user_affiliate_events.id, parentEvent!.id));

    await enqueueAffiliateEventForUser({
      userId: user.id,
      provider: 'impact',
      eventType: 'trial_start',
      dedupeKey: buildAffiliateEventDedupeKey({
        provider: 'impact',
        eventType: 'trial_start',
        entityId: 'trial-subscription-unconfigured',
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
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
      unblocked: 0,
    });
    expect(rows.map(row => row.delivery_state).sort()).toEqual(['delivered', 'delivered']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('delivers a queued child after the parent processing gap passes', async () => {
    const user = await insertTestUser();
    const {
      buildAffiliateEventDedupeKey,
      dispatchQueuedAffiliateEvents,
      enqueueAffiliateEventForUser,
      recordAffiliateAttributionAndQueueParentEvent,
    } = await import('@/lib/affiliate-events');

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
        delivery_state: 'delivered',
        claimed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
        next_retry_at: null,
      })
      .where(eq(user_affiliate_events.id, parentEvent!.id));

    await enqueueAffiliateEventForUser({
      userId: user.id,
      provider: 'impact',
      eventType: 'trial_start',
      dedupeKey: buildAffiliateEventDedupeKey({
        provider: 'impact',
        eventType: 'trial_start',
        entityId: 'trial-subscription-older-parent',
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
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
      unblocked: 0,
    });
    expect(rows.map(row => row.delivery_state).sort()).toEqual(['delivered', 'delivered']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
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

  it('reconciles blocked children whose parent was already delivered but does not claim them until the processing gap passes', async () => {
    const user = await insertTestUser();
    const {
      buildAffiliateEventDedupeKey,
      dispatchQueuedAffiliateEvents,
      enqueueAffiliateEventForUser,
      recordAffiliateAttributionAndQueueParentEvent,
    } = await import('@/lib/affiliate-events');

    const parentEvent = await recordAffiliateAttributionAndQueueParentEvent({
      userId: user.id,
      provider: 'impact',
      trackingId: 'impact-click-123',
      customerEmail: user.google_user_email,
      eventDate: new Date('2026-04-09T10:00:00.000Z'),
    });

    expect(parentEvent).not.toBeNull();

    await enqueueAffiliateEventForUser({
      userId: user.id,
      provider: 'impact',
      eventType: 'trial_start',
      dedupeKey: buildAffiliateEventDedupeKey({
        provider: 'impact',
        eventType: 'trial_start',
        entityId: 'trial-subscription-3',
      }),
      eventDate: new Date('2026-04-09T10:05:00.000Z'),
      orderId: 'IR_AN_64_TS',
    });

    await db
      .update(user_affiliate_events)
      .set({
        delivery_state: 'delivered',
        claimed_at: new Date().toISOString(),
        next_retry_at: null,
      })
      .where(eq(user_affiliate_events.id, parentEvent!.id));

    const fetchMock: typeof fetch = jest.fn(async () => new Response('', { status: 200 }));
    global.fetch = fetchMock;

    const summary = await dispatchQueuedAffiliateEvents();
    const rows = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(summary).toEqual({
      reclaimed: 0,
      claimed: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
      unblocked: 1,
    });
    expect(rows.map(row => row.delivery_state).sort()).toEqual(['delivered', 'queued']);
    expect(rows.find(row => row.event_type === 'trial_start')?.claimed_at).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('persists impact_action_id after sale dispatch succeeds immediately', async () => {
    const { saleEvent, summary } = await createDeliveredSaleEvent({ saleResponse: 'immediate' });

    expect(summary).toEqual({
      reclaimed: 0,
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
      unblocked: 0,
    });
    expect(saleEvent.delivery_state).toBe('delivered');
    expect(saleEvent.impact_action_id).toBe('1000.2000.3000');
    expect(saleEvent.impact_submission_uri).toBeNull();
    expect(saleEvent.stripe_charge_id).toBe('ch_sale_test_123');
  });

  it('persists impact_submission_uri after queued sale dispatch', async () => {
    const { saleEvent, summary } = await createDeliveredSaleEvent({ saleResponse: 'queued' });

    expect(summary).toEqual({
      reclaimed: 0,
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
      unblocked: 0,
    });
    expect(saleEvent.delivery_state).toBe('delivered');
    expect(saleEvent.impact_action_id).toBeNull();
    expect(saleEvent.impact_submission_uri).toBe(
      '/Advertisers/impact-account-sid/APISubmissions/A-sale-queued'
    );
  });

  it('blocks sale reversal until parent sale is delivered', async () => {
    const { user, saleEvent } = await createQueuedSaleEvent();
    const { enqueueImpactSaleReversalForCharge } = await import('@/lib/affiliate-events');

    await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_123',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:00:00.000Z'),
    });

    const rows = await getUserAffiliateEvents(user.id);
    const reversalEvent = rows.find(row => row.event_type === 'sale_reversal');

    expect(reversalEvent).toMatchObject({
      delivery_state: 'blocked',
      parent_event_id: saleEvent.id,
      stripe_charge_id: 'ch_sale_test_123',
    });
  });

  it('resolves queued sale submission to action id before reversal dispatch', async () => {
    const { user, saleEvent } = await createDeliveredSaleEvent({ saleResponse: 'queued' });
    const { dispatchQueuedAffiliateEvents, enqueueImpactSaleReversalForCharge } =
      await import('@/lib/affiliate-events');

    await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_queued_resolution',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:00:00.000Z'),
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ActionId: '1000.2000.3000',
            ActionUri: '/Advertisers/impact-account-sid/Actions/1000.2000.3000',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Status: 'QUEUED',
            QueuedUri: '/Advertisers/impact-account-sid/APISubmissions/A-reversal-queued',
          }),
          { status: 200 }
        )
      ) as jest.MockedFunction<typeof fetch>;

    const summary = await dispatchQueuedAffiliateEvents();
    const rows = await getUserAffiliateEvents(user.id);
    const refreshedSaleEvent = rows.find(row => row.id === saleEvent.id);
    const reversalEvent = rows.find(row => row.event_type === 'sale_reversal');

    expect(summary).toEqual({
      reclaimed: 0,
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
      unblocked: 0,
    });
    expect(refreshedSaleEvent?.impact_action_id).toBe('1000.2000.3000');
    expect(reversalEvent?.delivery_state).toBe('delivered');
    expect(reversalEvent?.impact_action_id).toBe('1000.2000.3000');
    expect(reversalEvent?.impact_submission_uri).toBe(
      '/Advertisers/impact-account-sid/APISubmissions/A-reversal-queued'
    );
  });

  it('fails queued sale reversal permanently when submission resolution is unconfigured', async () => {
    const { user } = await createDeliveredSaleEvent({ saleResponse: 'queued' });

    delete process.env.IMPACT_ACCOUNT_SID;
    delete process.env.IMPACT_AUTH_TOKEN;
    delete process.env.IMPACT_CAMPAIGN_ID;
    jest.resetModules();

    const { dispatchQueuedAffiliateEvents, enqueueImpactSaleReversalForCharge } =
      await import('@/lib/affiliate-events');

    await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_unconfigured_resolution',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:00:00.000Z'),
    });

    const summary = await dispatchQueuedAffiliateEvents();
    const reversalEvent = (await getUserAffiliateEvents(user.id)).find(
      row => row.event_type === 'sale_reversal'
    );

    expect(summary.failed).toBe(1);
    expect(summary.retried).toBe(0);
    expect(reversalEvent?.delivery_state).toBe('failed');
    expect(reversalEvent?.attempt_count).toBe(1);
    expect(reversalEvent?.next_retry_at).toBeNull();
  });

  it('retries sale reversal on retryable upstream failure', async () => {
    const { user } = await createDeliveredSaleEvent({ saleResponse: 'immediate' });
    const { dispatchQueuedAffiliateEvents, enqueueImpactSaleReversalForCharge } =
      await import('@/lib/affiliate-events');

    await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_retry',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:00:00.000Z'),
    });

    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response('retry later', { status: 503 })) as jest.MockedFunction<
      typeof fetch
    >;

    const summary = await dispatchQueuedAffiliateEvents();
    const reversalEvent = (await getUserAffiliateEvents(user.id)).find(
      row => row.event_type === 'sale_reversal'
    );

    expect(summary.retried).toBe(1);
    expect(reversalEvent?.delivery_state).toBe('queued');
    expect(reversalEvent?.attempt_count).toBe(1);
    expect(reversalEvent?.next_retry_at).not.toBeNull();
  });

  it('fails sale reversal permanently on client failure', async () => {
    const { user } = await createDeliveredSaleEvent({ saleResponse: 'immediate' });
    const { dispatchQueuedAffiliateEvents, enqueueImpactSaleReversalForCharge } =
      await import('@/lib/affiliate-events');

    await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_fail',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:00:00.000Z'),
    });

    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response('bad request', { status: 400 })) as jest.MockedFunction<
      typeof fetch
    >;

    const summary = await dispatchQueuedAffiliateEvents();
    const reversalEvent = (await getUserAffiliateEvents(user.id)).find(
      row => row.event_type === 'sale_reversal'
    );

    expect(summary.failed).toBe(1);
    expect(reversalEvent?.delivery_state).toBe('failed');
    expect(reversalEvent?.attempt_count).toBe(1);
  });

  it('fails blocked sale reversal when parent sale fails permanently', async () => {
    const { user, saleEvent } = await createQueuedSaleEvent();
    const { dispatchQueuedAffiliateEvents, enqueueImpactSaleReversalForCharge } =
      await import('@/lib/affiliate-events');

    await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_parent_failed',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:00:00.000Z'),
    });

    await db
      .update(user_affiliate_events)
      .set({
        delivery_state: 'failed',
      })
      .where(eq(user_affiliate_events.id, saleEvent.id));

    const summary = await dispatchQueuedAffiliateEvents();
    const reversalEvent = (await getUserAffiliateEvents(user.id)).find(
      row => row.event_type === 'sale_reversal'
    );

    expect(summary.failed).toBe(1);
    expect(reversalEvent?.delivery_state).toBe('failed');
    expect(reversalEvent?.attempt_count).toBe(1);
  });

  it('dedupes duplicate disputes for same stripe charge', async () => {
    const { user } = await createDeliveredSaleEvent({ saleResponse: 'immediate' });
    const { enqueueImpactSaleReversalForCharge } = await import('@/lib/affiliate-events');

    await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_first',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:00:00.000Z'),
    });
    await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_second',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:01:00.000Z'),
    });

    const reversalEvents = (await getUserAffiliateEvents(user.id)).filter(
      row => row.event_type === 'sale_reversal'
    );

    expect(reversalEvents).toHaveLength(1);
    expect(reversalEvents[0]?.dedupe_key).toBe('affiliate:impact:sale_reversal:ch_sale_test_123');
  });

  it('persists dispute when sale row is missing and materializes reversal once sale appears', async () => {
    const { enqueueImpactSaleReversalForCharge, dispatchQueuedAffiliateEvents } =
      await import('@/lib/affiliate-events');

    // Dispute arrives before invoice.paid has recorded the sale row.
    const deferredResult = await enqueueImpactSaleReversalForCharge({
      stripeChargeId: 'ch_sale_test_123',
      disputeId: 'dp_before_sale',
      amount: 29,
      currency: 'usd',
      eventDate: new Date('2026-04-10T10:00:00.000Z'),
    });
    expect(deferredResult).toBeNull();

    const pendingBefore = await db.select().from(pending_impact_sale_reversals);
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0]).toMatchObject({
      stripe_charge_id: 'ch_sale_test_123',
      dispute_id: 'dp_before_sale',
    });

    // Sale row arrives after the dispute was persisted.
    const { user } = await createDeliveredSaleEvent({ saleResponse: 'immediate' });

    // Reconciler on next dispatch materializes the pending dispute into a sale_reversal event
    // attached to the now-existing sale row, and removes the pending placeholder.
    await dispatchQueuedAffiliateEvents();

    const pendingAfter = await db.select().from(pending_impact_sale_reversals);
    expect(pendingAfter).toHaveLength(0);

    const reversalEvents = (await getUserAffiliateEvents(user.id)).filter(
      row => row.event_type === 'sale_reversal'
    );
    expect(reversalEvents).toHaveLength(1);
    expect(reversalEvents[0]).toMatchObject({
      stripe_charge_id: 'ch_sale_test_123',
      payload_json: expect.objectContaining({ disputeId: 'dp_before_sale' }),
    });
  });
});
