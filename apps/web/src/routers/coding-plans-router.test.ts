/* eslint-disable drizzle/enforce-delete-with-where */
import { generateText } from 'ai';
import { eq } from 'drizzle-orm';
import { decryptApiKey, encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { codingPlanCredentialFingerprint } from '@/lib/coding-plans/credential-fingerprint';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { uploadKeysToInventory } from '@/lib/coding-plans';
import { getBytePlusUsage } from '@/lib/coding-plans/byteplus-usage';
import { CODING_PLAN_IDS } from '@/lib/coding-plans/pricing';
import { redisClient } from '@/lib/redis';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  byok_api_keys,
  coding_plan_availability_intents,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual('@/lib/config.server'),
  BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID: 'test-byteplus-access',
  BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY: 'test-byteplus-secret',
}));
jest.mock('@/lib/coding-plans/byteplus-usage', () => ({
  getBytePlusUsage: jest.fn(),
}));
jest.mock('ai', () => ({
  createGateway: jest.fn(() => jest.fn((modelId: string) => ({ modelId }))),
  generateText: jest.fn(),
}));
jest.mock('@/lib/redis', () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
}));

const PLAN_ID = 'minimax-token-plan-plus';
const MAX_PLAN_ID = 'minimax-token-plan-max';
const ULTRA_PLAN_ID = 'minimax-token-plan-ultra';
const BYTEPLUS_PLAN_ID = 'byteplus-coding-plan-team-lite';
const BYTEPLUS_PRO_PLAN_ID = 'byteplus-coding-plan-team-pro';
const COST_MICRODOLLARS = 20_000_000;
const MAX_COST_MICRODOLLARS = 50_000_000;
const mockedGenerateText = jest.mocked(generateText);
const mockedGetBytePlusUsage = jest.mocked(getBytePlusUsage);
const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedRedisDel = jest.mocked(redisClient.del);

function inventoryEntry(key: string, upstreamPlanId = `minimax-plan-${crypto.randomUUID()}`) {
  return `${key}::${upstreamPlanId}`;
}

async function insertInventory(
  overrides: Partial<typeof coding_plan_key_inventory.$inferInsert> = {}
) {
  const [row] = await db
    .insert(coding_plan_key_inventory)
    .values({
      plan_id: PLAN_ID,
      provider_id: 'minimax',
      upstream_plan_id: `minimax-plan-${crypto.randomUUID()}`,
      encrypted_api_key: encryptApiKey('old-secret', BYOK_ENCRYPTION_KEY),
      credential_fingerprint: crypto.randomUUID(),
      status: 'available',
      ...overrides,
    })
    .returning();
  return row;
}

function emptyInsightPlan(planId: string) {
  return {
    planId,
    liveSubscriptions: 0,
    monthlyRecurringValueKiloCredits: 0,
    createdInRange: 0,
    canceledInRange: 0,
    currentWaitersJoinedInRange: 0,
    currentWaitlistTotal: 0,
  };
}

function catalogInsightPlans(
  overrides: Partial<
    Record<(typeof CODING_PLAN_IDS)[number], Partial<ReturnType<typeof emptyInsightPlan>>>
  > = {}
) {
  return CODING_PLAN_IDS.map(planId => ({
    ...emptyInsightPlan(planId),
    ...overrides[planId],
  }));
}

function subscriptionValues(
  userId: string,
  overrides: Partial<typeof coding_plan_subscriptions.$inferInsert> = {}
) {
  return {
    user_id: userId,
    plan_id: PLAN_ID,
    provider_id: 'minimax',
    status: 'canceled' as const,
    cost_microdollars: COST_MICRODOLLARS,
    billing_period_days: 30,
    current_period_start: '2026-06-20T12:00:00.000Z',
    current_period_end: '2026-07-20T12:00:00.000Z',
    credit_renewal_at: '2026-07-20T12:00:00.000Z',
    ...overrides,
  };
}

function usageResponse() {
  return new Response(
    JSON.stringify({
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 80,
          current_interval_status: 1,
          start_time: 1_781_262_000_000,
          end_time: 1_781_280_000_000,
          current_weekly_remaining_percent: 70,
          current_weekly_status: 1,
          weekly_start_time: 1_781_280_000_000,
          weekly_end_time: 1_781_884_800_000,
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

beforeEach(() => {
  mockedGetBytePlusUsage.mockResolvedValue({
    fetchedAt: '2026-08-06T12:00:00.000Z',
    windows: [
      {
        id: 'short_term',
        remainingPercent: 80,
        resetsAt: '2026-08-06T17:00:00.000Z',
        period: { unit: 'hour', value: 5 },
      },
      {
        id: 'weekly',
        remainingPercent: 70,
        resetsAt: '2026-08-13T12:00:00.000Z',
        period: { unit: 'week', value: 1 },
      },
      {
        id: 'monthly',
        remainingPercent: 60,
        resetsAt: '2026-09-05T12:00:00.000Z',
        period: { unit: 'month', value: 1 },
      },
    ],
  });
  mockedRedisGet.mockResolvedValue(null);
  mockedRedisSet.mockResolvedValue('OK');
  mockedRedisDel.mockResolvedValue(1);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.delete(coding_plan_availability_intents);
  await db.delete(coding_plan_terms);
  await db.delete(coding_plan_subscriptions);
  await db.delete(byok_api_keys);
  await db.delete(coding_plan_key_inventory);
  await db.delete(credit_transactions);
  await db.delete(kilocode_users);
  jest.clearAllMocks();
});

describe('coding plans router', () => {
  it('serves the configured Coding Plan catalog in Kilo Credits', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(caller.codingPlans.catalog()).resolves.toEqual([
      {
        planId: PLAN_ID,
        providerName: 'MiniMax',
        name: 'Token Plan Plus',
        providerId: 'minimax',
        costKiloCredits: 20,
        billingPeriodDays: 30,
        features: expect.arrayContaining(['~1.7B tokens per month of M3 usage.']),
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      },
      {
        planId: MAX_PLAN_ID,
        providerName: 'MiniMax',
        name: 'Token Plan Max',
        providerId: 'minimax',
        costKiloCredits: 50,
        billingPeriodDays: 30,
        features: expect.arrayContaining([
          '~5.1B tokens per month of M3 usage.',
          'Run 4-5 concurrent agents.',
        ]),
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      },
      {
        planId: ULTRA_PLAN_ID,
        providerName: 'MiniMax',
        name: 'Token Plan Ultra',
        providerId: 'minimax',
        costKiloCredits: 120,
        billingPeriodDays: 30,
        features: expect.arrayContaining([
          '~12.5B tokens per month of M3 usage.',
          'Run 6-7 concurrent agents.',
        ]),
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      },
      {
        planId: BYTEPLUS_PLAN_ID,
        providerName: 'BytePlus',
        name: 'Enterprise Coding Plan Lite',
        providerId: 'byteplus-coding',
        costKiloCredits: 20,
        billingPeriodDays: 30,
        features: expect.arrayContaining([
          'Kilo automatically configures BytePlus in your BYOK settings.',
          'Zero Data Retention: does not retain prompts or train on your data',
        ]),
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      },
      {
        planId: BYTEPLUS_PRO_PLAN_ID,
        providerName: 'BytePlus',
        name: 'Enterprise Coding Plan Pro',
        providerId: 'byteplus-coding',
        costKiloCredits: 100,
        billingPeriodDays: 30,
        features: expect.arrayContaining([
          'Zero Data Retention: does not retain prompts or train on your data',
          'For complex, high-intensity development use.',
          'Approximately 9,500 requests every 5 hours, 60,000 requests per week, and 120,000 requests per 30-day subscription period.',
        ]),
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      },
    ]);
  });

  it('reports available capacity without exposing inventory and rejects notify requests while in stock', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`catalog-available-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );

    await expect(caller.codingPlans.catalog()).resolves.toEqual([
      expect.objectContaining({
        planId: PLAN_ID,
        availabilityStatus: 'available',
        notificationRequested: false,
      }),
      expect.objectContaining({
        planId: MAX_PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      }),
      expect.objectContaining({
        planId: ULTRA_PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      }),
      expect.objectContaining({
        planId: BYTEPLUS_PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      }),
      expect.objectContaining({
        planId: BYTEPLUS_PRO_PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      }),
    ]);
    await expect(
      caller.codingPlans.requestAvailabilityNotification({ planId: PLAN_ID })
    ).rejects.toThrow('currently available');
  });

  it('persists one notification intent when a sold-out user requests availability updates', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.codingPlans.requestAvailabilityNotification({ planId: PLAN_ID })
    ).resolves.toEqual({ requested: true });
    await expect(
      caller.codingPlans.requestAvailabilityNotification({ planId: PLAN_ID })
    ).resolves.toEqual({ requested: true });

    const intents = await db.select().from(coding_plan_availability_intents);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ user_id: user.id, plan_id: PLAN_ID });
    await expect(caller.codingPlans.catalog()).resolves.toEqual([
      expect.objectContaining({
        planId: PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: true,
      }),
      expect.objectContaining({
        planId: MAX_PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      }),
      expect.objectContaining({
        planId: ULTRA_PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      }),
      expect.objectContaining({
        planId: BYTEPLUS_PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      }),
      expect.objectContaining({
        planId: BYTEPLUS_PRO_PLAN_ID,
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      }),
    ]);
  });

  it('clears an availability notification intent when the user later subscribes', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    const caller = await createCallerForUser(user.id);
    await caller.codingPlans.requestAvailabilityNotification({ planId: PLAN_ID });
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`notify-activation-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );

    await caller.codingPlans.subscribe({ planId: PLAN_ID, idempotencyKey: 'notify-activation' });

    expect(await db.select().from(coding_plan_availability_intents)).toHaveLength(0);
  });

  it('rejects purchase while a disabled personal MiniMax BYOK key occupies setup', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    const caller = await createCallerForUser(user.id);
    const key = await caller.byok.create({ provider_id: 'minimax', api_key: 'existing-key' });
    await caller.byok.setEnabled({ id: key.id, is_enabled: false });
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`unused-router-key-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );

    await expect(
      caller.codingPlans.subscribe({ planId: PLAN_ID, idempotencyKey: 'blocked-slot' })
    ).rejects.toThrow(
      'Remove your existing MiniMax BYOK key from /byok before subscribing to a MiniMax Coding Plan'
    );
    const [savedUser] = await db.select().from(kilocode_users);
    const subscriptions = await db.select().from(coding_plan_subscriptions);
    const terms = await db.select().from(coding_plan_terms);

    expect(savedUser.microdollars_used).toBe(0);
    expect(subscriptions).toHaveLength(0);
    expect(terms).toHaveLength(0);
  });

  it('creates and reads only the owner subscription and credit billing history', async () => {
    const owner = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    const otherUser = await insertTestUser();
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`router-managed-key-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );
    const ownerCaller = await createCallerForUser(owner.id);
    const otherCaller = await createCallerForUser(otherUser.id);

    const activation = await ownerCaller.codingPlans.subscribe({
      planId: PLAN_ID,
      idempotencyKey: 'router-activation-request',
    });
    const subscriptions = await ownerCaller.codingPlans.listSubscriptions();
    const detail = await ownerCaller.codingPlans.getSubscriptionDetail({
      subscriptionId: activation.subscriptionId,
    });
    const billing = await ownerCaller.codingPlans.getBillingHistory({
      subscriptionId: activation.subscriptionId,
    });

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({ canQueryUsage: true });
    expect(detail).toMatchObject({
      id: activation.subscriptionId,
      planId: PLAN_ID,
      planName: 'Token Plan Plus',
      providerName: 'MiniMax',
      providerId: 'minimax',
      routeLabel: 'MiniMax via Kilo Gateway',
      features: expect.arrayContaining(['~1.7B tokens per month of M3 usage.']),
      canQueryUsage: true,
      hasInstalledByokKey: true,
      status: 'active',
      costKiloCredits: 20,
      billingPeriodDays: 30,
      cancelAtPeriodEnd: false,
    });
    expect(detail.currentPeriodEnd).toContain('T');
    expect(billing).toEqual({
      entries: [
        {
          kind: 'credits',
          id: expect.any(String),
          date: expect.stringContaining('T'),
          amountMicrodollars: COST_MICRODOLLARS,
          description: 'Coding plan: MiniMax Token Plan Plus',
        },
      ],
      hasMore: false,
      cursor: null,
    });

    const [installedKey] = await db
      .select({ id: byok_api_keys.id })
      .from(byok_api_keys)
      .where(eq(byok_api_keys.kilo_user_id, owner.id))
      .limit(1);
    if (!installedKey) {
      throw new Error('Expected Coding Plan activation to install a BYOK key');
    }
    await expect(
      ownerCaller.codingPlans.getSubscriptionDetail({ subscriptionId: activation.subscriptionId })
    ).resolves.toMatchObject({ hasInstalledByokKey: true });

    await expect(
      otherCaller.codingPlans.getSubscriptionDetail({ subscriptionId: activation.subscriptionId })
    ).rejects.toThrow('Coding Plan subscription not found.');
    await expect(
      otherCaller.codingPlans.getBillingHistory({ subscriptionId: activation.subscriptionId })
    ).rejects.toThrow('Coding Plan subscription not found.');
  });

  it('returns owner-scoped managed usage without exposing the credential', async () => {
    const managedKey = `sk-cp-managed-${crypto.randomUUID()}`;
    const owner = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    const otherUser = await insertTestUser();
    await uploadKeysToInventory('minimax', PLAN_ID, [inventoryEntry(managedKey)], {
      validateCredential: async () => true,
    });
    const ownerCaller = await createCallerForUser(owner.id);
    const otherCaller = await createCallerForUser(otherUser.id);
    const activation = await ownerCaller.codingPlans.subscribe({
      planId: PLAN_ID,
      idempotencyKey: 'managed-usage',
    });
    const request = jest.spyOn(global, 'fetch').mockImplementation(async () => usageResponse());

    const active = await ownerCaller.codingPlans.getUsage({
      subscriptionId: activation.subscriptionId,
    });
    expect(active).toEqual({
      schemaVersion: 1,
      fetchedAt: expect.stringContaining('T'),
      subscription: {
        id: activation.subscriptionId,
        planId: PLAN_ID,
        planName: 'Token Plan Plus',
        providerId: 'minimax',
        providerName: 'MiniMax',
        windows: [
          {
            id: 'short_term',
            remainingPercent: 80,
            startsAt: new Date(1_781_262_000_000).toISOString(),
            resetsAt: new Date(1_781_280_000_000).toISOString(),
            period: { unit: 'hour', value: 5 },
          },
          {
            id: 'weekly',
            remainingPercent: 70,
            startsAt: new Date(1_781_280_000_000).toISOString(),
            resetsAt: new Date(1_781_884_800_000).toISOString(),
            period: { unit: 'week', value: 1 },
          },
        ],
      },
    });
    expect(JSON.stringify(active)).not.toContain(managedKey);
    await expect(
      otherCaller.codingPlans.getUsage({ subscriptionId: activation.subscriptionId })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Coding Plan subscription not found.',
    });

    expect(request).toHaveBeenCalledTimes(1);
    for (const call of request.mock.calls) {
      expect(call[0]).toBe('https://api.minimax.io/v1/token_plan/remains');
      expect(call[1]?.headers).toEqual(
        expect.objectContaining({ Authorization: `Bearer ${managedKey}` })
      );
    }
  });

  it('serves owner-scoped BytePlus usage for Lite without exposing seat metadata', async () => {
    const owner = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    const otherUser = await insertTestUser();
    await uploadKeysToInventory(
      'byteplus-coding',
      BYTEPLUS_PLAN_ID,
      [inventoryEntry('byteplus-inference-key', 'assigned-byteplus-username')],
      {
        validateCredential: async () => ({
          valid: true,
          upstreamUsageId: 'seat-byteplus-lite',
        }),
      }
    );
    const ownerCaller = await createCallerForUser(owner.id);
    const otherCaller = await createCallerForUser(otherUser.id);
    const activation = await ownerCaller.codingPlans.subscribe({
      planId: BYTEPLUS_PLAN_ID,
      idempotencyKey: 'byteplus-usage',
    });

    const subscriptions = await ownerCaller.codingPlans.listSubscriptions();
    const detail = await ownerCaller.codingPlans.getSubscriptionDetail({
      subscriptionId: activation.subscriptionId,
    });
    const usage = await ownerCaller.codingPlans.getUsage({
      subscriptionId: activation.subscriptionId,
    });

    expect(subscriptions[0]).toMatchObject({ canQueryUsage: true });
    expect(detail).toMatchObject({
      providerId: 'byteplus-coding',
      planId: BYTEPLUS_PLAN_ID,
      canQueryUsage: true,
    });
    expect(detail).not.toHaveProperty('hasUpstreamUsageId');
    expect(JSON.stringify({ subscriptions, detail, usage })).not.toContain('seat-byteplus-lite');
    expect(usage.subscription.windows.map(window => window.id)).toEqual([
      'short_term',
      'weekly',
      'monthly',
    ]);
    expect(mockedGetBytePlusUsage).toHaveBeenCalledWith('seat-byteplus-lite');

    await expect(
      otherCaller.codingPlans.getUsage({ subscriptionId: activation.subscriptionId })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Coding Plan subscription not found.',
    });
  });

  it('serves usage for non-terminal subscriptions and rejects terminal ones', async () => {
    const owner = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`sk-cp-state-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );
    const caller = await createCallerForUser(owner.id);
    const activation = await caller.codingPlans.subscribe({
      planId: PLAN_ID,
      idempotencyKey: 'usage-states',
    });
    jest.spyOn(global, 'fetch').mockImplementation(async () => usageResponse());
    const past = new Date(Date.now() - 60_000).toISOString();

    // A period deadline that already passed does not end usage early; the
    // billing lifecycle sweep owns termination.
    await db
      .update(coding_plan_subscriptions)
      .set({ status: 'active', cancel_at_period_end: true, current_period_end: past })
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));
    await expect(
      caller.codingPlans.getUsage({ subscriptionId: activation.subscriptionId })
    ).resolves.toMatchObject({ subscription: { id: activation.subscriptionId } });

    await db
      .update(coding_plan_subscriptions)
      .set({ status: 'past_due', cancel_at_period_end: false, payment_grace_expires_at: past })
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));
    await expect(
      caller.codingPlans.getUsage({ subscriptionId: activation.subscriptionId })
    ).resolves.toMatchObject({ subscription: { id: activation.subscriptionId } });

    await db
      .update(coding_plan_subscriptions)
      .set({ status: 'canceled' })
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));
    const cacheReadsBeforeCancellation = mockedRedisGet.mock.calls.length;
    await expect(
      caller.codingPlans.getUsage({ subscriptionId: activation.subscriptionId })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Coding Plan subscription is not eligible for usage.',
    });
    expect(mockedRedisGet).toHaveBeenCalledTimes(cacheReadsBeforeCancellation);
    await expect(
      caller.codingPlans.getSubscriptionDetail({ subscriptionId: activation.subscriptionId })
    ).resolves.toMatchObject({ canQueryUsage: false });
  });

  it('fails safely for a corrupt inventory assignment without affecting database-only reads', async () => {
    const owner = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`sk-cp-corrupt-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );
    const caller = await createCallerForUser(owner.id);
    const activation = await caller.codingPlans.subscribe({
      planId: PLAN_ID,
      idempotencyKey: 'corrupt-assignment',
    });
    const [subscription] = await db
      .select({ inventoryId: coding_plan_subscriptions.key_inventory_id })
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));
    if (!subscription.inventoryId) throw new Error('Expected assigned inventory');
    await db
      .update(coding_plan_key_inventory)
      .set({ assigned_to_user_id: null })
      .where(eq(coding_plan_key_inventory.id, subscription.inventoryId));
    const request = jest.spyOn(global, 'fetch');

    await expect(
      caller.codingPlans.getUsage({ subscriptionId: activation.subscriptionId })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Coding Plan usage is unavailable.',
    });
    expect(request).not.toHaveBeenCalled();
    await expect(caller.codingPlans.listSubscriptions()).resolves.toHaveLength(1);
    await expect(
      caller.codingPlans.getSubscriptionDetail({ subscriptionId: activation.subscriptionId })
    ).resolves.toMatchObject({
      id: activation.subscriptionId,
      status: 'active',
      canQueryUsage: false,
    });
  });

  it('isolates upstream usage failures from subscription metadata', async () => {
    const owner = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`sk-cp-upstream-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );
    const caller = await createCallerForUser(owner.id);
    const activation = await caller.codingPlans.subscribe({
      planId: PLAN_ID,
      idempotencyKey: 'upstream-failure',
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('raw provider failure', { status: 503 }));

    await expect(
      caller.codingPlans.getUsage({ subscriptionId: activation.subscriptionId })
    ).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
      message: 'Coding Plan usage is temporarily unavailable.',
    });
    await expect(caller.codingPlans.listSubscriptions()).resolves.toHaveLength(1);
    await expect(
      caller.codingPlans.getSubscriptionDetail({ subscriptionId: activation.subscriptionId })
    ).resolves.toMatchObject({ id: activation.subscriptionId });
  });

  it('rejects a second live purchase instead of creating a prepaid extension', async () => {
    const owner = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS * 2,
      microdollars_used: 0,
    });
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`second-purchase-key-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );
    const caller = await createCallerForUser(owner.id);
    await caller.codingPlans.subscribe({ planId: PLAN_ID, idempotencyKey: 'first-purchase' });

    await expect(
      caller.codingPlans.subscribe({ planId: PLAN_ID, idempotencyKey: 'new-purchase' })
    ).rejects.toThrow('already has a live subscription');
    expect(await db.select().from(coding_plan_terms)).toHaveLength(1);
  });

  it('rejects subscribing to another MiniMax token plan while one is live', async () => {
    const owner = await insertTestUser({
      total_microdollars_acquired: COST_MICRODOLLARS + MAX_COST_MICRODOLLARS,
      microdollars_used: 0,
    });
    await uploadKeysToInventory(
      'minimax',
      PLAN_ID,
      [inventoryEntry(`provider-plus-key-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );
    await uploadKeysToInventory(
      'minimax',
      MAX_PLAN_ID,
      [inventoryEntry(`provider-max-key-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );
    const caller = await createCallerForUser(owner.id);
    await caller.codingPlans.subscribe({ planId: PLAN_ID, idempotencyKey: 'first-provider-plan' });

    await expect(
      caller.codingPlans.subscribe({ planId: MAX_PLAN_ID, idempotencyKey: 'second-provider-plan' })
    ).rejects.toThrow('MiniMax Coding Plan already has a live subscription');
    expect(await db.select().from(coding_plan_terms)).toHaveLength(1);
  });

  it('accepts provider and plan when admins upload inventory', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(admin.id);
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);

    await expect(
      caller.codingPlans.adminUploadKeys({
        providerId: 'minimax',
        planId: MAX_PLAN_ID,
        entries: [inventoryEntry('admin-max-upload', `provider-plan-${crypto.randomUUID()}`)],
      })
    ).resolves.toEqual({ inserted: 1 });

    const [inventory] = await db.select().from(coding_plan_key_inventory);
    expect(inventory).toMatchObject({
      provider_id: 'minimax',
      plan_id: MAX_PLAN_ID,
      status: 'available',
    });
  });

  it('rejects admin uploads when provider and plan do not match', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.codingPlans.adminUploadKeys({
        providerId: 'anthropic',
        planId: MAX_PLAN_ID,
        entries: [inventoryEntry('admin-provider-mismatch')],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('does not match provider'),
    });
  });

  it('reports malformed admin inventory entries as a request error', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.codingPlans.adminUploadKeys({
        providerId: 'minimax',
        planId: PLAN_ID,
        entries: ['missing-plan-id'],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('<api key>::<upstream plan id>'),
    });
  });

  it('restricts manual remediation and returns only the MiniMax plan ID needed to deprovision', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const subscriptionExpiresAt = '2026-07-20T12:00:00.000Z';
    const [workItem] = await db
      .insert(coding_plan_key_inventory)
      .values({
        plan_id: PLAN_ID,
        provider_id: 'minimax',
        upstream_plan_id: 'minimax-deprovision-plan',
        encrypted_api_key: encryptApiKey('unreturned-secret', BYOK_ENCRYPTION_KEY),
        credential_fingerprint: crypto.randomUUID(),
        status: 'revocation_pending',
        revocation_requested_at: new Date().toISOString(),
      })
      .returning();
    await db.insert(coding_plan_subscriptions).values({
      user_id: user.id,
      plan_id: PLAN_ID,
      provider_id: 'minimax',
      key_inventory_id: workItem.id,
      status: 'canceled',
      cost_microdollars: COST_MICRODOLLARS,
      billing_period_days: 30,
      current_period_start: '2026-06-20T12:00:00.000Z',
      current_period_end: subscriptionExpiresAt,
      credit_renewal_at: subscriptionExpiresAt,
      canceled_at: subscriptionExpiresAt,
      cancellation_reason: 'user_cancelled',
    });
    const adminCaller = await createCallerForUser(admin.id);
    const userCaller = await createCallerForUser(user.id);

    await expect(userCaller.codingPlans.adminRevocationQueue({})).rejects.toThrow();
    const queue = await adminCaller.codingPlans.adminRevocationQueue({});
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      inventoryKeyId: workItem.id,
      planId: PLAN_ID,
      providerId: 'minimax',
      upstreamPlanId: 'minimax-deprovision-plan',
      subscriptionExpiresAt,
    });
    expect(queue[0]).not.toHaveProperty('encrypted_api_key');
    expect(queue[0]).not.toHaveProperty('apiKey');

    await adminCaller.codingPlans.adminMarkRevocationFailed({
      inventoryKeyId: workItem.id,
      reason: 'Failed with bearer secret-token',
    });
    const [failed] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, workItem.id));
    expect(failed.status).toBe('revocation_failed');
    expect(failed.encrypted_api_key).toBeNull();
    expect(failed.last_revocation_error).toContain('bearer [redacted]');

    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);
    await adminCaller.codingPlans.adminReplaceRevocationCredential({
      inventoryKeyId: workItem.id,
      apiKey: 'replacement-minimax-key',
    });
    const [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, workItem.id));
    expect(credential.status).toBe('available');
    expect(credential.upstream_plan_id).toBe('minimax-deprovision-plan');
    expect(credential.encrypted_api_key).not.toBeNull();

    await db
      .update(coding_plan_key_inventory)
      .set({ status: 'revocation_pending', encrypted_api_key: null })
      .where(eq(coding_plan_key_inventory.id, workItem.id));
    await adminCaller.codingPlans.adminMarkRevocationComplete({ inventoryKeyId: workItem.id });
    const [revoked] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, workItem.id));
    expect(revoked.status).toBe('revoked');
    expect(revoked.upstream_plan_id).toBe('minimax-deprovision-plan');
    expect(revoked.encrypted_api_key).toBeNull();
  });

  it('returns one queue row per inventory credential when multiple canceled subscriptions reference it', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const firstUser = await insertTestUser();
    const secondUser = await insertTestUser();
    const [workItem] = await db
      .insert(coding_plan_key_inventory)
      .values({
        plan_id: PLAN_ID,
        provider_id: 'minimax',
        upstream_plan_id: 'minimax-deprovision-plan',
        encrypted_api_key: encryptApiKey('unreturned-secret', BYOK_ENCRYPTION_KEY),
        credential_fingerprint: crypto.randomUUID(),
        status: 'revocation_pending',
        revocation_requested_at: new Date().toISOString(),
      })
      .returning();
    await db.insert(coding_plan_subscriptions).values([
      {
        user_id: firstUser.id,
        plan_id: PLAN_ID,
        provider_id: 'minimax',
        key_inventory_id: workItem.id,
        status: 'canceled',
        cost_microdollars: COST_MICRODOLLARS,
        billing_period_days: 30,
        current_period_start: '2026-06-10T13:55:16.000Z',
        current_period_end: '2026-07-10T13:55:16.000Z',
        credit_renewal_at: '2026-07-10T13:55:16.000Z',
        canceled_at: '2026-07-10T13:55:16.000Z',
        cancellation_reason: 'user_cancelled',
      },
      {
        user_id: secondUser.id,
        plan_id: PLAN_ID,
        provider_id: 'minimax',
        key_inventory_id: workItem.id,
        status: 'canceled',
        cost_microdollars: COST_MICRODOLLARS,
        billing_period_days: 30,
        current_period_start: '2026-07-11T02:47:07.000Z',
        current_period_end: '2026-08-11T02:47:07.000Z',
        credit_renewal_at: '2026-08-11T02:47:07.000Z',
        canceled_at: '2026-08-11T02:47:07.000Z',
        cancellation_reason: 'user_cancelled',
      },
    ]);
    const caller = await createCallerForUser(admin.id);

    await expect(caller.codingPlans.adminRevocationQueue({})).resolves.toEqual([
      expect.objectContaining({
        inventoryKeyId: workItem.id,
        subscriptionExpiresAt: '2026-08-11T02:47:07.000Z',
      }),
    ]);
  });

  it('returns pending inventory credentials that have no subscription reference', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const [workItem] = await db
      .insert(coding_plan_key_inventory)
      .values({
        plan_id: PLAN_ID,
        provider_id: 'minimax',
        upstream_plan_id: 'minimax-orphan-plan',
        encrypted_api_key: encryptApiKey('unreturned-secret', BYOK_ENCRYPTION_KEY),
        credential_fingerprint: crypto.randomUUID(),
        status: 'revocation_pending',
        revocation_requested_at: new Date().toISOString(),
      })
      .returning();
    const caller = await createCallerForUser(admin.id);

    await expect(caller.codingPlans.adminRevocationQueue({})).resolves.toEqual([
      expect.objectContaining({
        inventoryKeyId: workItem.id,
        subscriptionExpiresAt: null,
      }),
    ]);
  });

  it('uses the latest subscription period end when three subscriptions reference one inventory credential', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const users = await Promise.all([insertTestUser(), insertTestUser(), insertTestUser()]);
    const [workItem] = await db
      .insert(coding_plan_key_inventory)
      .values({
        plan_id: PLAN_ID,
        provider_id: 'minimax',
        upstream_plan_id: 'minimax-three-ref-plan',
        encrypted_api_key: encryptApiKey('unreturned-secret', BYOK_ENCRYPTION_KEY),
        credential_fingerprint: crypto.randomUUID(),
        status: 'revocation_pending',
        revocation_requested_at: new Date().toISOString(),
      })
      .returning();
    const periodEnds = [
      '2026-06-01T00:00:00.000Z',
      '2026-08-15T12:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ] as const;
    await db.insert(coding_plan_subscriptions).values(
      users.map((user, index) => {
        const currentPeriodEnd = periodEnds[index] ?? periodEnds[0];
        return {
          user_id: user.id,
          plan_id: PLAN_ID,
          provider_id: 'minimax',
          key_inventory_id: workItem.id,
          status: 'canceled' as const,
          cost_microdollars: COST_MICRODOLLARS,
          billing_period_days: 30,
          current_period_start: '2026-05-01T00:00:00.000Z',
          current_period_end: currentPeriodEnd,
          credit_renewal_at: currentPeriodEnd,
          canceled_at: currentPeriodEnd,
          cancellation_reason: 'user_cancelled',
        };
      })
    );
    const caller = await createCallerForUser(admin.id);

    await expect(caller.codingPlans.adminRevocationQueue({})).resolves.toEqual([
      expect.objectContaining({
        inventoryKeyId: workItem.id,
        subscriptionExpiresAt: '2026-08-15T12:00:00.000Z',
      }),
    ]);
  });

  it('paginates admin subscriptions 20 per page with totals', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const users = await Promise.all(Array.from({ length: 23 }, () => insertTestUser()));
    await db.insert(coding_plan_subscriptions).values(
      users.map((user, index) =>
        subscriptionValues(user.id, {
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        })
      )
    );
    const caller = await createCallerForUser(admin.id);

    const firstPage = await caller.codingPlans.adminListSubscriptions({ page: 1 });
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.pagination).toEqual({ page: 1, total: 23, totalPages: 2 });

    const secondPage = await caller.codingPlans.adminListSubscriptions({ page: 2 });
    expect(secondPage.items).toHaveLength(3);
    expect(secondPage.pagination).toEqual({ page: 2, total: 23, totalPages: 2 });
  });

  it('searches admin subscriptions by user id and email substring', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const emailUser = await insertTestUser({
      google_user_email: 'unique-search-target@example.com',
      normalized_email: 'unique-search-target@example.com',
    });
    const idUser = await insertTestUser({ id: 'searchable-user-id-42' });
    const otherUser = await insertTestUser();
    await db
      .insert(coding_plan_subscriptions)
      .values([
        subscriptionValues(emailUser.id),
        subscriptionValues(idUser.id),
        subscriptionValues(otherUser.id),
      ]);
    const caller = await createCallerForUser(admin.id);

    const emailMatches = await caller.codingPlans.adminListSubscriptions({
      search: 'unique-search-target',
    });
    expect(emailMatches.items).toEqual([
      expect.objectContaining({
        userId: emailUser.id,
        userEmail: 'unique-search-target@example.com',
      }),
    ]);

    const idMatches = await caller.codingPlans.adminListSubscriptions({
      search: 'searchable-user-id',
    });
    expect(idMatches.items).toEqual([expect.objectContaining({ userId: idUser.id })]);
  });

  it('filters admin subscriptions by display status', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const activeUser = await insertTestUser();
    const pendingUser = await insertTestUser();
    const activeInventory = await insertInventory({ status: 'assigned' });
    const pendingInventory = await insertInventory({ status: 'assigned' });
    await db.insert(coding_plan_subscriptions).values([
      subscriptionValues(activeUser.id, {
        key_inventory_id: activeInventory.id,
        status: 'active',
        cancel_at_period_end: false,
      }),
      subscriptionValues(pendingUser.id, {
        key_inventory_id: pendingInventory.id,
        status: 'active',
        cancel_at_period_end: true,
      }),
    ]);
    const caller = await createCallerForUser(admin.id);

    const active = await caller.codingPlans.adminListSubscriptions({ status: 'active' });
    expect(active.items).toEqual([expect.objectContaining({ userId: activeUser.id })]);

    const pending = await caller.codingPlans.adminListSubscriptions({
      status: 'pending_cancellation',
    });
    expect(pending.items).toEqual([expect.objectContaining({ userId: pendingUser.id })]);
  });

  it('schedules admin cancellation at period end and rejects canceled subscriptions', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const inventory = await insertInventory({ status: 'assigned' });
    const [active] = await db
      .insert(coding_plan_subscriptions)
      .values(
        subscriptionValues(user.id, {
          key_inventory_id: inventory.id,
          status: 'active',
        })
      )
      .returning();
    const [canceled] = await db
      .insert(coding_plan_subscriptions)
      .values(
        subscriptionValues(user.id, {
          plan_id: MAX_PLAN_ID,
          status: 'canceled',
          canceled_at: '2026-07-20T12:00:00.000Z',
          cancellation_reason: 'user_cancelled',
        })
      )
      .returning();
    const caller = await createCallerForUser(admin.id);

    await caller.codingPlans.adminCancelSubscription({ subscriptionId: active.id });
    const [updated] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, active.id));
    expect(updated.cancel_at_period_end).toBe(true);
    expect(updated.status).toBe('active');

    await expect(
      caller.codingPlans.adminCancelSubscription({ subscriptionId: canceled.id })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No active subscription found.',
    });
  });

  it('extends an active subscription period and rejects canceled or invalid days', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const inventory = await insertInventory({ status: 'assigned' });
    const [active] = await db
      .insert(coding_plan_subscriptions)
      .values(
        subscriptionValues(user.id, {
          key_inventory_id: inventory.id,
          status: 'active',
          current_period_end: '2026-07-20T12:00:00.000Z',
          credit_renewal_at: '2026-07-20T12:00:00.000Z',
        })
      )
      .returning();
    const [canceled] = await db
      .insert(coding_plan_subscriptions)
      .values(
        subscriptionValues(user.id, {
          plan_id: MAX_PLAN_ID,
          status: 'canceled',
          canceled_at: '2026-07-20T12:00:00.000Z',
          cancellation_reason: 'user_cancelled',
        })
      )
      .returning();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.codingPlans.adminExtendSubscriptionPeriod({
        subscriptionId: active.id,
        days: 7,
      })
    ).resolves.toEqual({
      currentPeriodEnd: '2026-07-27T12:00:00.000Z',
      creditRenewalAt: '2026-07-27T12:00:00.000Z',
    });

    const [extensionTerm] = await db
      .select()
      .from(coding_plan_terms)
      .where(eq(coding_plan_terms.subscription_id, active.id));
    expect(extensionTerm).toMatchObject({
      user_id: user.id,
      plan_id: PLAN_ID,
      kind: 'extension',
      cost_microdollars: 0,
    });
    expect(new Date(extensionTerm.period_start).toISOString()).toBe('2026-07-20T12:00:00.000Z');
    expect(new Date(extensionTerm.period_end).toISOString()).toBe('2026-07-27T12:00:00.000Z');
    const [extensionTransaction] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.id, extensionTerm.credit_transaction_id));
    expect(extensionTransaction).toMatchObject({
      kilo_user_id: user.id,
      amount_microdollars: 0,
      is_free: true,
      created_by_kilo_user_id: admin.id,
      description: 'Coding plan extension: 7 additional days',
    });

    await expect(
      caller.codingPlans.adminExtendSubscriptionPeriod({
        subscriptionId: canceled.id,
        days: 7,
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No active subscription found.',
    });
    await expect(
      caller.codingPlans.adminExtendSubscriptionPeriod({
        subscriptionId: active.id,
        days: 0,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.codingPlans.adminExtendSubscriptionPeriod({
        subscriptionId: active.id,
        days: 91,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('replaces available and assigned inventory credentials and rejects ineligible keys', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const available = await insertInventory({
      encrypted_api_key: encryptApiKey('old-secret', BYOK_ENCRYPTION_KEY),
      credential_fingerprint: codingPlanCredentialFingerprint('old-secret'),
    });
    const assigned = await insertInventory({
      encrypted_api_key: encryptApiKey('assigned-old-secret', BYOK_ENCRYPTION_KEY),
      credential_fingerprint: codingPlanCredentialFingerprint('assigned-old-secret'),
      status: 'assigned',
      assigned_to_user_id: user.id,
    });
    const [installedByok] = await db
      .insert(byok_api_keys)
      .values({
        kilo_user_id: user.id,
        organization_id: null,
        provider_id: 'minimax',
        encrypted_api_key: encryptApiKey('assigned-old-secret', BYOK_ENCRYPTION_KEY),
        management_source: 'coding_plan',
        created_by: user.id,
      })
      .returning();
    await db.insert(coding_plan_subscriptions).values(
      subscriptionValues(user.id, {
        key_inventory_id: assigned.id,
        installed_byok_key_id: installedByok.id,
        status: 'active',
      })
    );
    const duplicate = await insertInventory({
      encrypted_api_key: encryptApiKey('already-present-key', BYOK_ENCRYPTION_KEY),
      credential_fingerprint: codingPlanCredentialFingerprint('already-present-key'),
    });
    const pending = await insertInventory({ status: 'revocation_pending' });
    const caller = await createCallerForUser(admin.id);

    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);
    await caller.codingPlans.adminReplaceInventoryCredential({
      inventoryKeyId: available.id,
      apiKey: 'available-replacement-key',
    });
    const [replacedAvailable] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, available.id));
    expect(replacedAvailable.status).toBe('available');
    expect(replacedAvailable.credential_fingerprint).toBe(
      codingPlanCredentialFingerprint('available-replacement-key')
    );
    expect(replacedAvailable.encrypted_api_key).not.toBeNull();
    expect(decryptApiKey(replacedAvailable.encrypted_api_key!, BYOK_ENCRYPTION_KEY)).toBe(
      'available-replacement-key'
    );

    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);
    await caller.codingPlans.adminReplaceInventoryCredential({
      inventoryKeyId: assigned.id,
      apiKey: 'assigned-replacement-key',
    });
    const [replacedAssigned] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, assigned.id));
    const [replacedByok] = await db
      .select()
      .from(byok_api_keys)
      .where(eq(byok_api_keys.id, installedByok.id));
    expect(replacedAssigned.status).toBe('assigned');
    expect(replacedAssigned.encrypted_api_key).not.toBeNull();
    expect(decryptApiKey(replacedAssigned.encrypted_api_key!, BYOK_ENCRYPTION_KEY)).toBe(
      'assigned-replacement-key'
    );
    expect(decryptApiKey(replacedByok.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe(
      'assigned-replacement-key'
    );

    await expect(
      caller.codingPlans.adminReplaceInventoryCredential({
        inventoryKeyId: available.id,
        apiKey: 'available-replacement-key',
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('must be different from the current credential'),
    });
    await expect(
      caller.codingPlans.adminReplaceInventoryCredential({
        inventoryKeyId: available.id,
        apiKey: 'already-present-key',
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('already present in inventory'),
    });
    await expect(
      caller.codingPlans.adminReplaceInventoryCredential({
        inventoryKeyId: pending.id,
        apiKey: 'pending-replacement-key',
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Credential is not eligible for replacement.',
    });
    expect(duplicate.status).toBe('available');
  });

  it('rejects inventory replacement after the stored credential identity changes', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const available = await insertInventory({
      encrypted_api_key: encryptApiKey('first-secret', BYOK_ENCRYPTION_KEY),
      credential_fingerprint: codingPlanCredentialFingerprint('first-secret'),
    });
    const caller = await createCallerForUser(admin.id);
    let resolveValidation: (() => void) | undefined;
    const validationGate = new Promise<void>(resolve => {
      resolveValidation = resolve;
    });
    mockedGenerateText.mockImplementationOnce(async () => {
      await db
        .update(coding_plan_key_inventory)
        .set({
          credential_fingerprint: codingPlanCredentialFingerprint('changed-secret'),
          encrypted_api_key: encryptApiKey('changed-secret', BYOK_ENCRYPTION_KEY),
        })
        .where(eq(coding_plan_key_inventory.id, available.id));
      resolveValidation?.();
      return { finishReason: 'stop' } as never;
    });

    const replacement = caller.codingPlans.adminReplaceInventoryCredential({
      inventoryKeyId: available.id,
      apiKey: 'next-secret',
    });
    await validationGate;
    await expect(replacement).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Credential changed during replacement. Refresh and try again.',
    });
    const [unchanged] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, available.id));
    expect(unchanged.credential_fingerprint).toBe(
      codingPlanCredentialFingerprint('changed-secret')
    );
    expect(decryptApiKey(unchanged.encrypted_api_key!, BYOK_ENCRYPTION_KEY)).toBe('changed-secret');
  });

  it('returns bounded subscription summary and selectable-range insight aggregates', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const activeUser = await insertTestUser();
    const retainedUser = await insertTestUser();
    const pendingUser = await insertTestUser();
    const pastDueUser = await insertTestUser();
    const canceledUser = await insertTestUser();
    const resolvedUser = await insertTestUser();
    const byteplusUser = await insertTestUser();
    const byteplusWaiter = await insertTestUser();
    const historicalUser = await insertTestUser();
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const activeInventory = await insertInventory();
    const retainedInventory = await insertInventory();
    const pendingInventory = await insertInventory();
    const pastDueInventory = await insertInventory();
    const byteplusInventory = await insertInventory({
      plan_id: BYTEPLUS_PLAN_ID,
      provider_id: 'byteplus-coding',
    });
    await db.insert(coding_plan_subscriptions).values([
      subscriptionValues(activeUser.id, {
        status: 'active',
        key_inventory_id: activeInventory.id,
        created_at: daysAgo(3),
      }),
      subscriptionValues(retainedUser.id, {
        status: 'active',
        key_inventory_id: retainedInventory.id,
        created_at: daysAgo(15),
      }),
      subscriptionValues(pendingUser.id, {
        status: 'active',
        cancel_at_period_end: true,
        key_inventory_id: pendingInventory.id,
        created_at: daysAgo(10),
      }),
      subscriptionValues(pastDueUser.id, {
        status: 'past_due',
        key_inventory_id: pastDueInventory.id,
        created_at: daysAgo(40),
      }),
      subscriptionValues(canceledUser.id, {
        created_at: daysAgo(45),
        canceled_at: daysAgo(5),
        cancellation_reason: 'user_cancelled',
      }),
      subscriptionValues(byteplusUser.id, {
        plan_id: BYTEPLUS_PLAN_ID,
        provider_id: 'byteplus-coding',
        status: 'active',
        key_inventory_id: byteplusInventory.id,
        created_at: daysAgo(2),
      }),
      subscriptionValues(historicalUser.id, {
        plan_id: 'legacy-unknown-plan',
        provider_id: 'legacy-provider',
        created_at: daysAgo(3),
        canceled_at: daysAgo(2),
        cancellation_reason: 'user_cancelled',
      }),
    ]);
    await db.insert(coding_plan_availability_intents).values([
      {
        user_id: canceledUser.id,
        plan_id: PLAN_ID,
        created_at: daysAgo(4),
      },
      {
        user_id: pendingUser.id,
        plan_id: PLAN_ID,
        created_at: daysAgo(10),
      },
      {
        user_id: resolvedUser.id,
        plan_id: PLAN_ID,
        created_at: daysAgo(12),
      },
      {
        user_id: byteplusWaiter.id,
        plan_id: BYTEPLUS_PLAN_ID,
        created_at: daysAgo(1),
      },
      {
        user_id: historicalUser.id,
        plan_id: 'legacy-unknown-plan',
        created_at: daysAgo(1),
      },
    ]);
    await db.insert(credit_transactions).values({
      kilo_user_id: resolvedUser.id,
      amount_microdollars: -COST_MICRODOLLARS,
      is_free: false,
      description: 'Coding plan activation',
    });
    const [activationTransaction] = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, resolvedUser.id));
    const [resolvedSubscription] = await db
      .insert(coding_plan_subscriptions)
      .values(
        subscriptionValues(resolvedUser.id, {
          created_at: daysAgo(11),
          canceled_at: daysAgo(11),
          cancellation_reason: 'user_cancelled',
        })
      )
      .returning();
    await db.insert(coding_plan_terms).values({
      subscription_id: resolvedSubscription.id,
      user_id: resolvedUser.id,
      plan_id: PLAN_ID,
      kind: 'activation',
      idempotency_key: `activation:${resolvedUser.id}`,
      period_start: daysAgo(11),
      period_end: daysAgo(-19),
      cost_microdollars: COST_MICRODOLLARS,
      credit_transaction_id: activationTransaction.id,
      created_at: daysAgo(11),
    });
    const caller = await createCallerForUser(admin.id);

    await expect(caller.codingPlans.adminSubscriptionOverview()).resolves.toEqual({
      total: 8,
      active: 3,
      pendingCancellation: 1,
      pastDue: 1,
    });
    const sevenDayInsights = await caller.codingPlans.adminInsights({ rangeDays: 7 });
    expect(sevenDayInsights.plans).toHaveLength(CODING_PLAN_IDS.length);
    expect(sevenDayInsights.plans.map(plan => plan.planId)).toEqual([...CODING_PLAN_IDS]);
    expect(sevenDayInsights).toEqual({
      rangeDays: 7,
      totals: {
        liveSubscriptions: 5,
        pendingCancellation: 1,
        pastDue: 1,
        mrrKiloCredits: 100,
        revenueAtRiskKiloCredits: 40,
        pastDueMrrKiloCredits: 20,
        createdInRange: 2,
        createdInPriorRange: 2,
        canceledInRange: 1,
        liveAtRangeStart: 4,
        retainedFromRangeStart: 3,
        currentWaitersJoinedInRange: 2,
        currentWaitersJoinedInPriorRange: 1,
        currentWaitlistTotal: 3,
      },
      plans: catalogInsightPlans({
        [PLAN_ID]: {
          liveSubscriptions: 4,
          monthlyRecurringValueKiloCredits: 80,
          createdInRange: 1,
          canceledInRange: 1,
          currentWaitersJoinedInRange: 1,
          currentWaitlistTotal: 2,
        },
        [BYTEPLUS_PLAN_ID]: {
          liveSubscriptions: 1,
          monthlyRecurringValueKiloCredits: 20,
          createdInRange: 1,
          currentWaitersJoinedInRange: 1,
          currentWaitlistTotal: 1,
        },
      }),
    });
    await expect(caller.codingPlans.adminInsights({ rangeDays: 14 })).resolves.toMatchObject({
      rangeDays: 14,
      totals: {
        createdInRange: 4,
        createdInPriorRange: 1,
        canceledInRange: 2,
        currentWaitersJoinedInRange: 3,
        currentWaitersJoinedInPriorRange: 0,
        currentWaitlistTotal: 3,
      },
      plans: catalogInsightPlans({
        [PLAN_ID]: {
          liveSubscriptions: 4,
          monthlyRecurringValueKiloCredits: 80,
          createdInRange: 3,
          canceledInRange: 2,
          currentWaitersJoinedInRange: 2,
          currentWaitlistTotal: 2,
        },
        [BYTEPLUS_PLAN_ID]: {
          liveSubscriptions: 1,
          monthlyRecurringValueKiloCredits: 20,
          createdInRange: 1,
          currentWaitersJoinedInRange: 1,
          currentWaitlistTotal: 1,
        },
      }),
    });
    await expect(caller.codingPlans.adminInsights({ rangeDays: 30 })).resolves.toMatchObject({
      rangeDays: 30,
      totals: {
        createdInRange: 5,
        createdInPriorRange: 2,
        canceledInRange: 2,
        currentWaitersJoinedInRange: 3,
        currentWaitersJoinedInPriorRange: 0,
        currentWaitlistTotal: 3,
      },
    });
  });
});
