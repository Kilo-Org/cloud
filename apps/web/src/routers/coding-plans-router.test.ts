/* eslint-disable drizzle/enforce-delete-with-where */
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

const PLAN_ID = 'minimax-token-plan-plus';
const COST_MICRODOLLARS = 20_000_000;

function inventoryEntry(key: string) {
  return `${key}::minimax-plan-${crypto.randomUUID()}`;
}

afterEach(async () => {
  await db.delete(coding_plan_availability_intents);
  await db.delete(coding_plan_terms);
  await db.delete(coding_plan_subscriptions);
  await db.delete(byok_api_keys);
  await db.delete(coding_plan_key_inventory);
  await db.delete(credit_transactions);
  await db.delete(kilocode_users);
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
        availabilityStatus: 'sold_out',
        notificationRequested: false,
      },
    ]);
  });

  it('reports available capacity without exposing inventory and rejects notify requests while in stock', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);
    await uploadKeysToInventory(
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
      PLAN_ID,
      [inventoryEntry(`unused-router-key-${crypto.randomUUID()}`)],
      {
        validateCredential: async () => true,
      }
    );

    await expect(
      caller.codingPlans.subscribe({ planId: PLAN_ID, idempotencyKey: 'blocked-slot' })
    ).rejects.toThrow('Remove your existing MiniMax BYOK key');
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

  it('reports malformed admin inventory entries as a request error', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.codingPlans.adminUploadKeys({ planId: PLAN_ID, entries: ['missing-plan-id'] })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('<api key>::<plan id>'),
    });
  });

  it('restricts manual remediation and returns only the MiniMax plan ID needed to deprovision', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
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
    const adminCaller = await createCallerForUser(admin.id);
    const userCaller = await createCallerForUser(user.id);

    await expect(userCaller.codingPlans.adminRevocationQueue({})).rejects.toThrow();
    const queue = await adminCaller.codingPlans.adminRevocationQueue({});
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      inventoryKeyId: workItem.id,
      planId: PLAN_ID,
      upstreamPlanId: 'minimax-deprovision-plan',
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

    await adminCaller.codingPlans.adminRequeueRevocation({ inventoryKeyId: workItem.id });
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
