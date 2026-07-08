/* eslint-disable drizzle/enforce-delete-with-where */
import { generateText } from 'ai';
import { eq } from 'drizzle-orm';
import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { uploadKeysToInventory } from '@/lib/coding-plans';
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

jest.mock('ai', () => ({
  createGateway: jest.fn(() => jest.fn((modelId: string) => ({ modelId }))),
  generateText: jest.fn(),
}));

const PLAN_ID = 'minimax-token-plan-plus';
const MAX_PLAN_ID = 'minimax-token-plan-max';
const ULTRA_PLAN_ID = 'minimax-token-plan-ultra';
const COST_MICRODOLLARS = 20_000_000;
const MAX_COST_MICRODOLLARS = 50_000_000;
const mockedGenerateText = jest.mocked(generateText);

function inventoryEntry(key: string, upstreamPlanId = `minimax-plan-${crypto.randomUUID()}`) {
  return `${key}::${upstreamPlanId}`;
}

afterEach(async () => {
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
    expect(detail).toMatchObject({
      id: activation.subscriptionId,
      planId: PLAN_ID,
      planName: 'Token Plan Plus',
      providerName: 'MiniMax',
      providerId: 'minimax',
      routeLabel: 'MiniMax via Kilo Gateway',
      features: expect.arrayContaining(['~1.7B tokens per month of M3 usage.']),
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
    await ownerCaller.byok.update({ id: installedKey.id, api_key: 'owner-replacement-key' });
    await expect(
      ownerCaller.codingPlans.getSubscriptionDetail({ subscriptionId: activation.subscriptionId })
    ).resolves.toMatchObject({ hasInstalledByokKey: false });

    await expect(
      otherCaller.codingPlans.getSubscriptionDetail({ subscriptionId: activation.subscriptionId })
    ).rejects.toThrow('Coding Plan subscription not found.');
    await expect(
      otherCaller.codingPlans.getBillingHistory({ subscriptionId: activation.subscriptionId })
    ).rejects.toThrow('Coding Plan subscription not found.');
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
});
