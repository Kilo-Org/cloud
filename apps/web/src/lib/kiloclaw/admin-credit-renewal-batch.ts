import 'server-only';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { kiloclaw_subscriptions } from '@kilocode/db/schema';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { db } from '@kilocode/web-shared/lib/drizzle';

import { createKiloClawAdminAuditLog } from './admin-audit-log';

const CHUNK_SIZE = 500;
const WORK_BUDGET_MS = 40_000;
const AUDIT_ACTION = 'kiloclaw.subscription.admin_cancel' as const;
const CHANGE_REASON = 'admin_stop_credit_renewal:kiloclaw_eol';

export type CreditRenewalAdminActor = {
  id: string;
  email: string;
  name: string | null;
};

function creditScope() {
  return and(
    eq(kiloclaw_subscriptions.payment_source, 'credits'),
    isNull(kiloclaw_subscriptions.stripe_subscription_id),
    isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
  );
}

function eligibleScope() {
  return and(
    creditScope(),
    inArray(kiloclaw_subscriptions.status, ['active', 'past_due']),
    eq(kiloclaw_subscriptions.cancel_at_period_end, false)
  );
}

export async function getCreditRenewalPreview() {
  const [counts] = await db
    .select({
      renewing: sql<number>`count(*) filter (where ${kiloclaw_subscriptions.cancel_at_period_end} = false and ${kiloclaw_subscriptions.status} in ('active', 'past_due'))::int`,
      ending: sql<number>`count(*) filter (where ${kiloclaw_subscriptions.cancel_at_period_end} = true and ${kiloclaw_subscriptions.status} in ('active', 'past_due'))::int`,
    })
    .from(kiloclaw_subscriptions)
    .where(creditScope());

  return {
    renewing: counts?.renewing ?? 0,
    ending: counts?.ending ?? 0,
  };
}

export async function stopCreditRenewals(actor: CreditRenewalAdminActor) {
  const deadlineAtMs = Date.now() + WORK_BUDGET_MS;
  let updated = 0;

  while (Date.now() < deadlineAtMs) {
    const fetched = await db.transaction(async tx => {
      const rows = await tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(eligibleScope())
        .orderBy(asc(kiloclaw_subscriptions.id))
        .limit(CHUNK_SIZE)
        .for('update', { skipLocked: true });

      for (const before of rows) {
        const [after] = await tx
          .update(kiloclaw_subscriptions)
          .set({
            cancel_at_period_end: true,
            stripe_schedule_id: null,
            scheduled_plan: null,
            scheduled_by: null,
          })
          .where(and(eq(kiloclaw_subscriptions.id, before.id), eligibleScope()))
          .returning();

        if (!after) continue;

        await insertKiloClawSubscriptionChangeLog(tx, {
          subscriptionId: before.id,
          actor: { actorType: 'user', actorId: actor.id },
          action: 'canceled',
          reason: CHANGE_REASON,
          before,
          after,
        });
        updated += 1;
      }
      return rows.length;
    });

    if (fetched < CHUNK_SIZE) break;
  }

  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(kiloclaw_subscriptions)
    .where(eligibleScope());
  const remaining = (pending?.count ?? 0) > 0;

  try {
    await createKiloClawAdminAuditLog({
      action: AUDIT_ACTION,
      actor_id: actor.id,
      actor_email: actor.email,
      actor_name: actor.name,
      target_user_id: actor.id,
      message: `Stopped credit renewal for ${updated} KiloClaw subscriptions${remaining ? '; more remain' : ''}`,
      metadata: {
        reason: 'KiloClaw end of life',
        scope: 'credit_renewals',
        updated,
        remaining,
      },
    });
  } catch (error) {
    console.error('[admin-credit-renewals] Failed to write admin audit log:', error);
  }

  return { updated, remaining };
}
