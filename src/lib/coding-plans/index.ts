import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import { addDays, format } from 'date-fns';

import { db } from '@/lib/drizzle';
import {
  byok_api_keys,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { encryptApiKey, decryptApiKey } from '@/lib/byok/encryption';
import { getCodingPlanPrice } from '@/lib/coding-plans/pricing';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { sentryLogger } from '@/lib/utils.server';

const logInfo = sentryLogger('coding-plans', 'info');
const logError = sentryLogger('coding-plans', 'error');

// ---------------------------------------------------------------------------
// subscribeToCodingPlan — spec §7.1 processing order
// ---------------------------------------------------------------------------

export async function subscribeToCodingPlan(
  userId: string,
  providerId: string
): Promise<{ subscriptionId: string }> {
  // 1. Validate catalog
  const plan = getCodingPlanPrice(providerId);
  if (!plan) {
    throw new Error(`Provider "${providerId}" is not available as a coding plan.`);
  }

  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK encryption is not configured');
  }

  const { costMicrodollars, billingPeriodDays } = plan;

  // 2. Check existing subscription
  const [existingSub] = await db
    .select()
    .from(coding_plan_subscriptions)
    .where(
      and(
        eq(coding_plan_subscriptions.user_id, userId),
        eq(coding_plan_subscriptions.provider_id, providerId)
      )
    )
    .limit(1);

  // Spec §2.5: If user already has an active subscription, extend it
  if (existingSub?.status === 'active') {
    return extendSubscription(existingSub, userId, costMicrodollars, billingPeriodDays);
  }

  // 3. Verify credit balance (spec §2.3)
  const [user] = await db
    .select({
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      microdollars_used: kilocode_users.microdollars_used,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error('User not found');
  }

  const balance = user.total_microdollars_acquired - user.microdollars_used;
  if (costMicrodollars > 0 && balance < costMicrodollars) {
    throw new Error(
      `Insufficient credit balance. You need ${costMicrodollars - balance} more microdollars.`
    );
  }

  // 4. Atomic transaction
  const now = new Date();
  const periodEnd = addDays(now, billingPeriodDays);
  const subscriptionId = existingSub?.id ?? crypto.randomUUID();
  const activationKey =
    existingSub?.status === 'canceled' ? (existingSub.canceled_at ?? existingSub.id) : 'initial';
  const deductionCategory = `coding-plan-activate:${providerId}:${userId}:${activationKey}`;

  let assignedKeyId: string | null = null;
  let skippedDuplicateActivation = false;

  await db.transaction(async tx => {
    // 4a. Deduct credits (idempotent)
    if (costMicrodollars > 0) {
      const deductionResult = await tx
        .insert(credit_transactions)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: userId,
          amount_microdollars: -costMicrodollars,
          is_free: false,
          description: `Coding plan: ${plan.name}`,
          credit_category: deductionCategory,
          check_category_uniqueness: true,
          original_baseline_microdollars_used: user.microdollars_used,
        })
        .onConflictDoNothing();

      if ((deductionResult.rowCount ?? 0) === 0) {
        // Already processed — idempotent duplicate
        skippedDuplicateActivation = true;
        logInfo('Duplicate subscription attempt', {
          user_id: userId,
          providerId,
        });
        return;
      }

      // 4b. Increment microdollars_used
      await tx
        .update(kilocode_users)
        .set({
          microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
        })
        .where(eq(kilocode_users.id, userId));
    }

    // 4c. Assign a pre-purchased key (spec §4.3)
    // FOR UPDATE SKIP LOCKED prevents concurrent assignment of the same key.
    const { rows: inventoryRows } = await tx.execute<{
      id: string;
      encrypted_api_key: { iv: string; data: string; authTag: string };
    }>(sql`
      UPDATE coding_plan_key_inventory
      SET assigned_to_user_id = ${userId},
          assigned_at = now()
      WHERE id = (
        SELECT id FROM coding_plan_key_inventory
        WHERE provider_id = ${providerId}
          AND assigned_to_user_id IS NULL
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, encrypted_api_key
    `);

    const inventoryKey = inventoryRows[0];
    if (!inventoryKey) {
      // No key available — the whole transaction rolls back (spec §4.3)
      throw new Error(
        `No pre-purchased API key available for provider "${providerId}". Subscription rejected.`
      );
    }

    // 4d. Decrypt inventory key and insert into byok_api_keys
    const plaintext = decryptApiKey(inventoryKey.encrypted_api_key, BYOK_ENCRYPTION_KEY);
    const reEncrypted = encryptApiKey(plaintext, BYOK_ENCRYPTION_KEY);

    // Guard against overwriting a user-managed BYOK key for the same provider.
    // Only allow upsert when re-subscribing (existing canceled subscription owns the key).
    const [existingByok] = await tx
      .select({ id: byok_api_keys.id })
      .from(byok_api_keys)
      .where(and(eq(byok_api_keys.kilo_user_id, userId), eq(byok_api_keys.provider_id, providerId)))
      .limit(1);

    if (existingByok && !existingSub) {
      throw new Error(
        `You already have a BYOK key configured for provider "${providerId}". Remove it before subscribing to a coding plan.`
      );
    }

    let byokId: string;
    if (existingByok) {
      // Re-subscribing: update the existing BYOK row in place
      await tx
        .update(byok_api_keys)
        .set({ encrypted_api_key: reEncrypted, is_enabled: true })
        .where(eq(byok_api_keys.id, existingByok.id));
      byokId = existingByok.id;
    } else {
      const [byokRow] = await tx
        .insert(byok_api_keys)
        .values({
          kilo_user_id: userId,
          organization_id: null,
          provider_id: providerId,
          encrypted_api_key: reEncrypted,
          created_by: userId,
        })
        .returning({ id: byok_api_keys.id });
      byokId = byokRow.id;
    }

    assignedKeyId = byokId;

    // 4e. Upsert subscription row
    const nowIso = now.toISOString();
    const periodEndIso = periodEnd.toISOString();

    if (existingSub) {
      // Re-subscribing after cancellation — update existing row.
      // Preserve canceled_at for audit history; the new period timestamps
      // and status='active' indicate the subscription is reactivated.
      await tx
        .update(coding_plan_subscriptions)
        .set({
          status: 'active',
          byok_key_id: assignedKeyId,
          cost_microdollars: costMicrodollars,
          billing_period_days: billingPeriodDays,
          current_period_start: nowIso,
          current_period_end: periodEndIso,
          credit_renewal_at: periodEndIso,
          cancel_at_period_end: false,
          auto_top_up_triggered_for_period: null,
        })
        .where(eq(coding_plan_subscriptions.id, existingSub.id));
    } else {
      await tx.insert(coding_plan_subscriptions).values({
        id: subscriptionId,
        user_id: userId,
        provider_id: providerId,
        byok_key_id: assignedKeyId,
        status: 'active',
        cost_microdollars: costMicrodollars,
        billing_period_days: billingPeriodDays,
        current_period_start: nowIso,
        current_period_end: periodEndIso,
        credit_renewal_at: periodEndIso,
        cancel_at_period_end: false,
      });
    }
  });

  if (skippedDuplicateActivation) {
    const [currentSub] = await db
      .select({ id: coding_plan_subscriptions.id })
      .from(coding_plan_subscriptions)
      .where(
        and(
          eq(coding_plan_subscriptions.user_id, userId),
          eq(coding_plan_subscriptions.provider_id, providerId)
        )
      )
      .limit(1);

    if (!currentSub) {
      throw new Error('Coding plan activation was already processed, but no subscription was found.');
    }

    return { subscriptionId: currentSub.id };
  }

  // 5. Post-transaction: evaluate Kilo Pass bonus (best-effort)
  if (costMicrodollars > 0) {
    try {
      await maybeIssueKiloPassBonusFromUsageThreshold({
        kiloUserId: userId,
        nowIso: new Date().toISOString(),
      });
    } catch (error) {
      logError('Kilo Pass bonus evaluation failed after coding plan subscription', {
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logInfo('Coding plan subscription created', {
    user_id: userId,
    providerId,
    subscriptionId,
    costMicrodollars,
  });

  return { subscriptionId: existingSub?.id ?? subscriptionId };
}

// ---------------------------------------------------------------------------
// extendSubscription — spec §2.5: stack new period onto existing end date
// ---------------------------------------------------------------------------

async function extendSubscription(
  existingSub: typeof coding_plan_subscriptions.$inferSelect,
  userId: string,
  costMicrodollars: number,
  billingPeriodDays: number
): Promise<{ subscriptionId: string }> {
  // Read current user balance
  const [user] = await db
    .select({
      microdollars_used: kilocode_users.microdollars_used,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (!user) throw new Error('User not found');

  const balance = user.total_microdollars_acquired - user.microdollars_used;
  if (costMicrodollars > 0 && balance < costMicrodollars) {
    throw new Error(
      `Insufficient credit balance. You need ${costMicrodollars - balance} more microdollars.`
    );
  }

  // Stack onto existing end date
  const currentEnd = existingSub.current_period_end
    ? new Date(existingSub.current_period_end)
    : new Date();
  const newEnd = addDays(currentEnd, billingPeriodDays);
  // Key off the period boundary being extended, not wall clock, for stable idempotency
  const periodKey = format(currentEnd, 'yyyy-MM-dd');
  const deductionCategory = `coding-plan-extend:${existingSub.provider_id}:${existingSub.id}:${periodKey}`;

  await db.transaction(async tx => {
    if (costMicrodollars > 0) {
      const deductionResult = await tx
        .insert(credit_transactions)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: userId,
          amount_microdollars: -costMicrodollars,
          is_free: false,
          description: `Coding plan extension: ${existingSub.provider_id}`,
          credit_category: deductionCategory,
          check_category_uniqueness: true,
          original_baseline_microdollars_used: user.microdollars_used,
        })
        .onConflictDoNothing();

      if ((deductionResult.rowCount ?? 0) === 0) {
        logInfo('Duplicate extension attempt', {
          user_id: userId,
          providerId: existingSub.provider_id,
        });
        return;
      }

      await tx
        .update(kilocode_users)
        .set({
          microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
        })
        .where(eq(kilocode_users.id, userId));
    }

    await tx
      .update(coding_plan_subscriptions)
      .set({
        current_period_end: newEnd.toISOString(),
        credit_renewal_at: newEnd.toISOString(),
        cancel_at_period_end: false,
      })
      .where(eq(coding_plan_subscriptions.id, existingSub.id));
  });

  // Post-transaction bonus evaluation
  if (costMicrodollars > 0) {
    try {
      await maybeIssueKiloPassBonusFromUsageThreshold({
        kiloUserId: userId,
        nowIso: new Date().toISOString(),
      });
    } catch (error) {
      logError('Kilo Pass bonus evaluation failed after coding plan extension', {
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logInfo('Coding plan subscription extended', {
    user_id: userId,
    providerId: existingSub.provider_id,
    newEndDate: newEnd.toISOString(),
  });

  return { subscriptionId: existingSub.id };
}

// ---------------------------------------------------------------------------
// cancelCodingPlanSubscription — user-facing cancel at period end
// ---------------------------------------------------------------------------

export async function cancelCodingPlanSubscription(
  userId: string,
  providerId: string
): Promise<void> {
  const result = await db
    .update(coding_plan_subscriptions)
    .set({ cancel_at_period_end: true })
    .where(
      and(
        eq(coding_plan_subscriptions.user_id, userId),
        eq(coding_plan_subscriptions.provider_id, providerId),
        eq(coding_plan_subscriptions.status, 'active')
      )
    );

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('No active subscription found for this provider.');
  }

  logInfo('Coding plan cancellation scheduled', {
    user_id: userId,
    providerId,
  });
}

// ---------------------------------------------------------------------------
// cancelCodingPlanImmediately — admin/GDPR immediate cancellation
// ---------------------------------------------------------------------------

export async function cancelCodingPlanImmediately(
  userId: string,
  providerId: string
): Promise<void> {
  const [sub] = await db
    .select({
      id: coding_plan_subscriptions.id,
      byok_key_id: coding_plan_subscriptions.byok_key_id,
    })
    .from(coding_plan_subscriptions)
    .where(
      and(
        eq(coding_plan_subscriptions.user_id, userId),
        eq(coding_plan_subscriptions.provider_id, providerId),
        eq(coding_plan_subscriptions.status, 'active')
      )
    )
    .limit(1);

  if (!sub) {
    throw new Error('No active subscription found for this provider.');
  }

  await db.transaction(async tx => {
    await tx
      .update(coding_plan_subscriptions)
      .set({
        status: 'canceled',
        canceled_at: sql`now()`,
        byok_key_id: null,
        cancel_at_period_end: false,
      })
      .where(eq(coding_plan_subscriptions.id, sub.id));

    // Spec §5.1: Remove from BYOK config, do NOT revoke with upstream
    if (sub.byok_key_id) {
      await tx.delete(byok_api_keys).where(eq(byok_api_keys.id, sub.byok_key_id));
    }
  });

  logInfo('Coding plan immediately canceled', { user_id: userId, providerId });
}

// ---------------------------------------------------------------------------
// Admin: upload pre-purchased keys to inventory
// ---------------------------------------------------------------------------

export async function uploadKeysToInventory(
  providerId: string,
  plaintextKeys: string[]
): Promise<{ inserted: number }> {
  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK encryption is not configured');
  }

  const values = plaintextKeys.map(key => ({
    provider_id: providerId,
    encrypted_api_key: encryptApiKey(key, BYOK_ENCRYPTION_KEY),
  }));

  const result = await db.insert(coding_plan_key_inventory).values(values);

  logInfo('Pre-purchased keys uploaded to inventory', {
    providerId,
    count: result.rowCount ?? 0,
  });

  return { inserted: result.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Admin: get key inventory counts
// ---------------------------------------------------------------------------

export async function getKeyInventoryCounts(
  providerId?: string
): Promise<Array<{ providerId: string; available: number; assigned: number }>> {
  const { rows } = await db.execute<{
    provider_id: string;
    available: string;
    assigned: string;
  }>(sql`
    SELECT
      provider_id,
      COUNT(*) FILTER (WHERE assigned_to_user_id IS NULL) AS available,
      COUNT(*) FILTER (WHERE assigned_to_user_id IS NOT NULL) AS assigned
    FROM coding_plan_key_inventory
    ${providerId ? sql`WHERE provider_id = ${providerId}` : sql``}
    GROUP BY provider_id
    ORDER BY provider_id
  `);

  return rows.map(r => ({
    providerId: r.provider_id,
    available: parseInt(r.available, 10),
    assigned: parseInt(r.assigned, 10),
  }));
}
