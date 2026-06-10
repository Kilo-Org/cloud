import 'server-only';

import { createHash, createHmac } from 'node:crypto';
import { addDays } from 'date-fns';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pLimit from 'p-limit';

import { decryptApiKey, encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { validateTokenPlanPlusCredential } from '@/lib/coding-plans/inventory-validation';
import { getCodingPlanPrice, type CodingPlanId } from '@/lib/coding-plans/pricing';
import { db } from '@/lib/drizzle';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { sentryLogger } from '@/lib/utils.server';
import {
  byok_api_keys,
  coding_plan_availability_intents,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
} from '@kilocode/db/schema';

const logInfo = sentryLogger('coding-plans', 'info');
const logError = sentryLogger('coding-plans', 'error');

// Credential validation calls the live MiniMax API per key. Bound the fan-out so
// large inventory uploads finish within the request budget without overwhelming
// the upstream provider with one unbounded burst of requests.
const INVENTORY_VALIDATION_CONCURRENCY = 10;

type CancellationReason =
  | 'user_canceled'
  | 'insufficient_credits'
  | 'account_deleted'
  | 'administrative_termination';

type SubscriptionOutcome = {
  subscriptionId: string;
  charged: boolean;
};

function idempotencyFingerprint(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

function credentialFingerprint(apiKey: string): string {
  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK encryption is not configured');
  }
  return createHmac('sha256', BYOK_ENCRYPTION_KEY).update(apiKey).digest('hex');
}

async function evaluateUsageBonus(userId: string): Promise<void> {
  try {
    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: userId,
      nowIso: new Date().toISOString(),
    });
  } catch (error) {
    logError('Kilo Pass bonus evaluation failed after coding plan charge', {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function subscribeToCodingPlan(
  userId: string,
  planId: string,
  idempotencyKey: string
): Promise<{ subscriptionId: string }> {
  const plan = getCodingPlanPrice(planId);
  if (!plan) {
    throw new Error(`Plan "${planId}" is not available as a coding plan.`);
  }
  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK encryption is not configured');
  }

  const requestKey = idempotencyFingerprint(idempotencyKey);
  const outcome = await db.transaction(async tx => {
    const { rows: lockedUsers } = await tx.execute<{
      total_microdollars_acquired: number;
      microdollars_used: number;
    }>(sql`
      SELECT total_microdollars_acquired, microdollars_used
      FROM kilocode_users
      WHERE id = ${userId}
      FOR UPDATE
    `);
    const lockedUser = lockedUsers[0];
    if (!lockedUser) {
      throw new Error('User not found');
    }

    const [priorTerm] = await tx
      .select({ subscriptionId: coding_plan_terms.subscription_id })
      .from(coding_plan_terms)
      .where(
        and(
          eq(coding_plan_terms.user_id, userId),
          eq(coding_plan_terms.plan_id, plan.planId),
          eq(coding_plan_terms.idempotency_key, requestKey)
        )
      )
      .limit(1);
    if (priorTerm) {
      return {
        subscriptionId: priorTerm.subscriptionId,
        charged: false,
      } satisfies SubscriptionOutcome;
    }

    const [liveSubscription] = await tx
      .select()
      .from(coding_plan_subscriptions)
      .where(
        and(
          eq(coding_plan_subscriptions.user_id, userId),
          eq(coding_plan_subscriptions.plan_id, plan.planId),
          inArray(coding_plan_subscriptions.status, ['active', 'past_due'])
        )
      )
      .limit(1);

    if (liveSubscription) {
      throw new Error(
        'Token Plan Plus already has a live subscription. Later billing periods are purchased through renewal.'
      );
    }

    const [existingProviderKey] = await tx
      .select({ id: byok_api_keys.id })
      .from(byok_api_keys)
      .where(
        and(eq(byok_api_keys.kilo_user_id, userId), eq(byok_api_keys.provider_id, plan.providerId))
      )
      .limit(1);
    if (existingProviderKey) {
      throw new Error(
        'Remove your existing MiniMax BYOK key from /byok before subscribing to Token Plan Plus.'
      );
    }

    const periodStart = new Date();
    const periodEnd = addDays(periodStart, plan.billingPeriodDays);
    const periodStartIso = periodStart.toISOString();
    const periodEndIso = periodEnd.toISOString();
    const transactionId = crypto.randomUUID();

    const { rows: chargedUsers } = await tx.execute<{ microdollars_used: number }>(sql`
      UPDATE kilocode_users
      SET microdollars_used = microdollars_used + ${plan.costMicrodollars}
      WHERE id = ${userId}
        AND total_microdollars_acquired - microdollars_used >= ${plan.costMicrodollars}
      RETURNING microdollars_used
    `);
    if (chargedUsers.length === 0) {
      throw new Error('Insufficient credit balance for this coding plan purchase.');
    }

    await tx.insert(credit_transactions).values({
      id: transactionId,
      kilo_user_id: userId,
      amount_microdollars: -plan.costMicrodollars,
      is_free: false,
      description: `Coding plan: ${plan.providerName} ${plan.name}`,
      credit_category: `coding-plan:${plan.planId}:${requestKey}`,
      check_category_uniqueness: true,
      original_baseline_microdollars_used: lockedUser.microdollars_used,
    });

    const { rows: inventoryRows } = await tx.execute<{
      id: string;
      encrypted_api_key: { iv: string; data: string; authTag: string } | null;
    }>(sql`
      UPDATE coding_plan_key_inventory
      SET status = 'assigned',
          assigned_to_user_id = ${userId},
          assigned_at = now(),
          updated_at = now()
      WHERE id = (
        SELECT id FROM coding_plan_key_inventory
        WHERE plan_id = ${plan.planId}
          AND status = 'available'
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, encrypted_api_key
    `);
    const inventoryKey = inventoryRows[0];
    if (!inventoryKey?.encrypted_api_key) {
      throw new Error(`No managed credential is available for plan "${plan.planId}".`);
    }

    const plaintext = decryptApiKey(inventoryKey.encrypted_api_key, BYOK_ENCRYPTION_KEY);
    const [installedByok] = await tx
      .insert(byok_api_keys)
      .values({
        kilo_user_id: userId,
        organization_id: null,
        provider_id: plan.providerId,
        encrypted_api_key: encryptApiKey(plaintext, BYOK_ENCRYPTION_KEY),
        management_source: 'coding_plan',
        created_by: userId,
      })
      .onConflictDoNothing()
      .returning({ id: byok_api_keys.id });
    if (!installedByok) {
      throw new Error(
        'Remove your existing MiniMax BYOK key from /byok before subscribing to Token Plan Plus.'
      );
    }

    const subscriptionId = crypto.randomUUID();
    await tx.insert(coding_plan_subscriptions).values({
      id: subscriptionId,
      user_id: userId,
      plan_id: plan.planId,
      provider_id: plan.providerId,
      key_inventory_id: inventoryKey.id,
      installed_byok_key_id: installedByok.id,
      status: 'active',
      cost_microdollars: plan.costMicrodollars,
      billing_period_days: plan.billingPeriodDays,
      current_period_start: periodStartIso,
      current_period_end: periodEndIso,
      credit_renewal_at: periodEndIso,
    });
    await tx.insert(coding_plan_terms).values({
      subscription_id: subscriptionId,
      user_id: userId,
      plan_id: plan.planId,
      kind: 'activation',
      idempotency_key: requestKey,
      period_start: periodStartIso,
      period_end: periodEndIso,
      cost_microdollars: plan.costMicrodollars,
      credit_transaction_id: transactionId,
    });
    await tx
      .delete(coding_plan_availability_intents)
      .where(
        and(
          eq(coding_plan_availability_intents.user_id, userId),
          eq(coding_plan_availability_intents.plan_id, plan.planId)
        )
      );
    return { subscriptionId, charged: true } satisfies SubscriptionOutcome;
  });

  if (outcome.charged) {
    await evaluateUsageBonus(userId);
  }
  logInfo('Coding plan purchase processed', {
    user_id: userId,
    planId: plan.planId,
    subscriptionId: outcome.subscriptionId,
    charged: outcome.charged,
  });
  return { subscriptionId: outcome.subscriptionId };
}

export async function cancelCodingPlanSubscription(
  userId: string,
  subscriptionId: string
): Promise<void> {
  const result = await db
    .update(coding_plan_subscriptions)
    .set({ cancel_at_period_end: true })
    .where(
      and(
        eq(coding_plan_subscriptions.id, subscriptionId),
        eq(coding_plan_subscriptions.user_id, userId),
        eq(coding_plan_subscriptions.status, 'active')
      )
    );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error('No active subscription found.');
  }
  logInfo('Coding plan cancellation scheduled', { user_id: userId, subscriptionId });
}

export async function terminateCodingPlanImmediately(
  subscriptionId: string,
  reason: CancellationReason = 'administrative_termination'
): Promise<void> {
  const [subscription] = await db
    .select({
      id: coding_plan_subscriptions.id,
      installed_byok_key_id: coding_plan_subscriptions.installed_byok_key_id,
      key_inventory_id: coding_plan_subscriptions.key_inventory_id,
    })
    .from(coding_plan_subscriptions)
    .where(
      and(
        eq(coding_plan_subscriptions.id, subscriptionId),
        inArray(coding_plan_subscriptions.status, ['active', 'past_due'])
      )
    )
    .limit(1);
  if (!subscription) {
    throw new Error('No live subscription found.');
  }

  await db.transaction(async tx => {
    await tx
      .update(coding_plan_subscriptions)
      .set({
        status: 'canceled',
        canceled_at: sql`now()`,
        cancellation_reason: reason,
        installed_byok_key_id: null,
        cancel_at_period_end: false,
        past_due_started_at: null,
        payment_grace_expires_at: null,
        auto_top_up_attempted_for_due: null,
      })
      .where(eq(coding_plan_subscriptions.id, subscription.id));
    if (subscription.installed_byok_key_id) {
      await tx
        .delete(byok_api_keys)
        .where(
          and(
            eq(byok_api_keys.id, subscription.installed_byok_key_id),
            eq(byok_api_keys.management_source, 'coding_plan')
          )
        );
    }
    if (subscription.key_inventory_id) {
      await tx
        .update(coding_plan_key_inventory)
        .set({
          status: 'revocation_pending',
          encrypted_api_key: null,
          revocation_requested_at: sql`now()`,
          last_revocation_error: null,
        })
        .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id));
    }
  });

  logInfo('Coding plan local access terminated; credential revocation pending', {
    subscriptionId,
    reason,
  });
}

type InventoryCredentialValidator = (apiKey: string) => Promise<boolean>;

type InventoryUploadOptions = {
  validateCredential?: InventoryCredentialValidator;
};

type InventoryCredentialEntry = {
  apiKey: string;
  upstreamPlanId: string;
};

function parseInventoryCredentialEntry(entry: string): InventoryCredentialEntry {
  const segments = entry.split('::');
  if (segments.length !== 2) {
    throw new Error('Each MiniMax inventory entry must use the format <api key>::<plan id>.');
  }

  const [rawApiKey, rawUpstreamPlanId] = segments;
  const apiKey = rawApiKey?.trim();
  const upstreamPlanId = rawUpstreamPlanId?.trim();
  if (!apiKey || !upstreamPlanId) {
    throw new Error('Each MiniMax inventory entry must use the format <api key>::<plan id>.');
  }

  return { apiKey, upstreamPlanId };
}

export async function uploadKeysToInventory(
  planId: CodingPlanId,
  rawEntries: string[],
  options: InventoryUploadOptions = {}
): Promise<{ inserted: number }> {
  const plan = getCodingPlanPrice(planId);
  if (!plan) {
    throw new Error(`Plan "${planId}" is not available as a coding plan.`);
  }
  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK encryption is not configured');
  }

  const entries = rawEntries.map(parseInventoryCredentialEntry);
  const validateCredential = options.validateCredential ?? validateTokenPlanPlusCredential;
  const limit = pLimit(INVENTORY_VALIDATION_CONCURRENCY);
  const validationResults = await Promise.all(
    entries.map(entry => limit(() => validateCredential(entry.apiKey)))
  );
  if (validationResults.some(isValid => !isValid)) {
    throw new Error(
      'One or more MiniMax credentials failed validation. Confirm plan access and supported model behavior, then try again.'
    );
  }

  const inserted = await db.transaction(async tx => {
    const result = await tx
      .insert(coding_plan_key_inventory)
      .values(
        entries.map(entry => ({
          plan_id: plan.planId,
          provider_id: plan.providerId,
          upstream_plan_id: entry.upstreamPlanId,
          encrypted_api_key: encryptApiKey(entry.apiKey, BYOK_ENCRYPTION_KEY),
          credential_fingerprint: credentialFingerprint(entry.apiKey),
          status: 'available' as const,
        }))
      )
      .onConflictDoNothing({ target: coding_plan_key_inventory.credential_fingerprint });
    const insertedCount = result.rowCount ?? 0;
    if (insertedCount !== entries.length) {
      throw new Error('One or more managed credentials are already present in inventory.');
    }
    return insertedCount;
  });

  logInfo('Validated managed credentials uploaded to coding plan inventory', {
    planId,
    count: inserted,
  });
  return { inserted };
}

export async function getAvailableCodingPlanIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ planId: coding_plan_key_inventory.plan_id })
    .from(coding_plan_key_inventory)
    .where(eq(coding_plan_key_inventory.status, 'available'));
  return rows.map(row => row.planId);
}

export async function getCodingPlanAvailabilityIntentPlanIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ planId: coding_plan_availability_intents.plan_id })
    .from(coding_plan_availability_intents)
    .where(eq(coding_plan_availability_intents.user_id, userId));
  return rows.map(row => row.planId);
}

export async function requestCodingPlanAvailabilityNotification(
  userId: string,
  planId: CodingPlanId
): Promise<{ requested: true }> {
  const plan = getCodingPlanPrice(planId);
  if (!plan) {
    throw new Error(`Plan "${planId}" is not available as a coding plan.`);
  }

  return db.transaction(async tx => {
    const [availableCredential] = await tx
      .select({ id: coding_plan_key_inventory.id })
      .from(coding_plan_key_inventory)
      .where(
        and(
          eq(coding_plan_key_inventory.plan_id, plan.planId),
          eq(coding_plan_key_inventory.status, 'available')
        )
      )
      .limit(1);
    if (availableCredential) {
      throw new Error(`${plan.providerName} ${plan.name} is currently available.`);
    }

    await tx
      .insert(coding_plan_availability_intents)
      .values({ user_id: userId, plan_id: plan.planId })
      .onConflictDoNothing();
    return { requested: true };
  });
}

export async function getKeyInventoryCounts(
  planId?: CodingPlanId
): Promise<Array<{ planId: string; status: string; count: number }>> {
  const { rows } = await db.execute<{ plan_id: string; status: string; count: string }>(sql`
    SELECT plan_id, status, COUNT(*) AS count
    FROM coding_plan_key_inventory
    ${planId ? sql`WHERE plan_id = ${planId}` : sql``}
    GROUP BY plan_id, status
    ORDER BY plan_id, status
  `);
  return rows.map(row => ({
    planId: row.plan_id,
    status: row.status,
    count: Number.parseInt(row.count, 10),
  }));
}
