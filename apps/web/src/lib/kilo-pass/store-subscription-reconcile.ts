import 'server-only';

import { kilo_pass_store_purchases, kilo_pass_subscriptions } from '@kilocode/db/schema';

import type { db as defaultDb } from '@/lib/drizzle';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassPaymentProvider,
} from '@/lib/kilo-pass/enums';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import { dayjs } from '@/lib/kilo-pass/dayjs';

type Db = typeof defaultDb;

const STORE_MANAGED_PROVIDERS = [
  KiloPassPaymentProvider.AppStore,
  KiloPassPaymentProvider.GooglePlay,
];

export type ReconcileStoreSubscriptionExpiryResult = {
  runId: string;
  nowIso: string;
  scannedSubscriptionCount: number;
  expiredSubscriptionCount: number;
  skippedNoStorePurchaseCount: number;
};

function isExpiredAtOrBeforeNow(expiresAt: string | null, nowMillis: number): boolean {
  if (!expiresAt) return false;
  const parsed = dayjs(expiresAt);
  if (!parsed.isValid()) return false;
  return parsed.valueOf() <= nowMillis;
}

export async function reconcileStoreSubscriptionExpiry(
  db: Db,
  params?: { now?: Date }
): Promise<ReconcileStoreSubscriptionExpiryResult> {
  const now = params?.now ? dayjs(params.now) : dayjs();
  const nowIso = now.utc().toISOString();
  const nowMillis = now.valueOf();
  const runId = crypto.randomUUID();

  const candidates = await db
    .select({
      subscriptionId: kilo_pass_subscriptions.id,
      kiloUserId: kilo_pass_subscriptions.kilo_user_id,
      paymentProvider: kilo_pass_subscriptions.payment_provider,
      providerSubscriptionId: kilo_pass_subscriptions.provider_subscription_id,
    })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        inArray(kilo_pass_subscriptions.payment_provider, STORE_MANAGED_PROVIDERS),
        ne(kilo_pass_subscriptions.status, 'canceled')
      )
    );

  let expiredSubscriptionCount = 0;
  let skippedNoStorePurchaseCount = 0;

  for (const candidate of candidates) {
    const latestStorePurchase = await db.query.kilo_pass_store_purchases.findFirst({
      where: and(
        eq(kilo_pass_store_purchases.kilo_pass_subscription_id, candidate.subscriptionId),
        eq(kilo_pass_store_purchases.payment_provider, candidate.paymentProvider)
      ),
      orderBy: desc(kilo_pass_store_purchases.purchased_at),
    });

    if (!latestStorePurchase) {
      skippedNoStorePurchaseCount += 1;
      continue;
    }

    if (!isExpiredAtOrBeforeNow(latestStorePurchase.expires_at, nowMillis)) {
      continue;
    }

    const updated = await db
      .update(kilo_pass_subscriptions)
      .set({
        status: 'canceled',
        cancel_at_period_end: false,
        ended_at: nowIso,
      })
      .where(
        and(
          eq(kilo_pass_subscriptions.id, candidate.subscriptionId),
          ne(kilo_pass_subscriptions.status, 'canceled')
        )
      )
      .returning({ id: kilo_pass_subscriptions.id });

    if (updated.length === 0) continue;

    expiredSubscriptionCount += 1;

    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.StoreSubscriptionExpired,
      result: KiloPassAuditLogResult.Success,
      kiloUserId: candidate.kiloUserId,
      kiloPassSubscriptionId: candidate.subscriptionId,
      payload: {
        scope: 'subscription',
        kind: 'store_subscription_reconcile',
        runId,
        paymentProvider: candidate.paymentProvider,
        providerSubscriptionId: candidate.providerSubscriptionId,
        expiresAt: latestStorePurchase.expires_at,
        endedAt: nowIso,
      },
    });
  }

  return {
    runId,
    nowIso,
    scannedSubscriptionCount: candidates.length,
    expiredSubscriptionCount,
    skippedNoStorePurchaseCount,
  };
}
