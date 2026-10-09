import { NotificationTypeV2 } from '@apple/app-store-server-library';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  credit_transactions,
  kilo_pass_audit_log,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilo_pass_store_events,
  kilocode_users,
  transactional_email_log,
} from '@kilocode/db/schema';
import type { User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { SendResult } from '@kilocode/web-shared/lib/email';
import {
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassPaymentProvider,
  KiloPassTier,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import { completeStoreCreditPurchase } from './store-completion';
import { dispatchStoreCreditWebTipEmails } from './store-credit-email';
import {
  restoreStoreCreditPurchase,
  reverseStoreCreditPurchase,
  STORE_FULL_MILLIUNITS,
} from './store-refund';
import { googlePlayCreditProviderTransactionId } from './store-verifier';
import type { ValidatedStoreCreditPurchase } from './store-verifier';

const NOW = new Date('2026-06-02T12:00:00.000Z');
const DUE_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    // Other suites share the worker database. Remove only this suite's schedules.
    await db
      .delete(kilo_pass_audit_log)
      .where(inArray(kilo_pass_audit_log.kilo_user_id, createdUserIds));
    createdUserIds.length = 0;
  }
});

function recordingSender() {
  return jest.fn<(to: string) => Promise<SendResult>>().mockResolvedValue({ sent: true });
}

async function grant(
  params: {
    user?: User;
    userFields?: Partial<User>;
    purchaseFields?: Partial<ValidatedStoreCreditPurchase>;
    grantedAt?: string;
  } = {}
) {
  const user = params.user ?? (await insertTestUser(params.userFields));
  if (!createdUserIds.includes(user.id)) createdUserIds.push(user.id);
  const purchase: ValidatedStoreCreditPurchase = {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: 'credits.usd10.v1',
    providerTransactionId: `tx-${crypto.randomUUID()}`,
    appAccountToken: null,
    quantity: 1,
    amountUsd: 10,
    amountMicrodollars: toMicrodollars(10),
    // An old receipt must not make a freshly granted purchase immediately due.
    purchasedAtIso: '2026-01-01T00:00:00.000Z',
    environment: 'Production',
    rawPayload: {},
    ...params.purchaseFields,
  };
  const result = await completeStoreCreditPurchase({ user, purchase });
  if (!result.creditTransactionId) throw new Error('Expected a granted credit transaction');
  const grantedAt = params.grantedAt ?? DUE_AT;
  await db
    .update(credit_transactions)
    .set({ created_at: grantedAt })
    .where(eq(credit_transactions.id, result.creditTransactionId));
  await db
    .update(kilo_pass_audit_log)
    .set({ created_at: grantedAt })
    .where(eq(kilo_pass_audit_log.related_credit_transaction_id, result.creditTransactionId));
  return { user, purchase, result };
}

function markersFor(userId: string) {
  return db
    .select()
    .from(transactional_email_log)
    .where(
      and(
        eq(transactional_email_log.email_type, 'store_credit_web_tip'),
        eq(transactional_email_log.idempotency_key, userId)
      )
    );
}

async function refundEvent(
  purchase: ValidatedStoreCreditPurchase,
  params: {
    notificationType?: string;
    providerTransactionId?: string;
    providerSubscriptionId?: string;
    signedDate?: number;
    processed?: boolean;
  } = {}
) {
  await db.insert(kilo_pass_store_events).values({
    payment_provider: purchase.paymentProvider,
    event_id: `email-refund-${crypto.randomUUID()}`,
    provider_transaction_id: params.providerTransactionId ?? purchase.providerTransactionId,
    provider_subscription_id: params.providerSubscriptionId,
    product_id: purchase.productId,
    environment: 'Production',
    payload_json: {
      notificationType: params.notificationType ?? NotificationTypeV2.REFUND,
      signedDate: params.signedDate ?? NOW.getTime() - 60_000,
    },
    processing_started_at: NOW.toISOString(),
    processed_at: params.processed === false ? null : NOW.toISOString(),
  });
}

async function webPurchase(
  userId: string,
  overrides: Partial<typeof credit_transactions.$inferInsert> = {}
) {
  await db.insert(credit_transactions).values({
    kilo_user_id: userId,
    amount_microdollars: toMicrodollars(10),
    is_free: false,
    stripe_payment_id: `ch_${crypto.randomUUID()}`,
    ...overrides,
  });
}

describe('first store credit email delivery', () => {
  it('waits a full 24 hours after the credit grant, including the exact boundary', async () => {
    const { user } = await grant();
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: new Date(NOW.getTime() - 1), sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await markersFor(user.id)).toEqual([]);

    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail.mock.calls).toEqual([[user.google_user_email]]);
    expect(await markersFor(user.id)).toHaveLength(1);
    await dispatchStoreCreditWebTipEmails({ now: new Date(NOW.getTime() + 1), sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('atomically claims one user when two crons select the same due grant', async () => {
    const { user } = await grant();
    const sendEmail = recordingSender();
    await Promise.all([
      dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail }),
      dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail }),
    ]);
    expect(sendEmail.mock.calls).toEqual([[user.google_user_email]]);
    expect(await markersFor(user.id)).toHaveLength(1);
  });

  it('delivers after production follows sandbox history', async () => {
    const sandbox = await grant({ purchaseFields: { environment: 'Sandbox' } });
    await grant({ user: sandbox.user });
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail.mock.calls).toEqual([[sandbox.user.google_user_email]]);
    expect(await markersFor(sandbox.user.id)).toHaveLength(1);
  });

  it('ignores subscription-linked credits even when their payment identity resembles a one-off charge', async () => {
    const { user } = await grant();
    const subscriptionId = crypto.randomUUID();
    const providerSubscriptionId = `sub_${crypto.randomUUID()}`;
    const issuanceId = crypto.randomUUID();
    const subscriptionCreditId = crypto.randomUUID();
    await db.insert(kilo_pass_subscriptions).values({
      id: subscriptionId,
      kilo_user_id: user.id,
      stripe_subscription_id: providerSubscriptionId,
      provider_subscription_id: providerSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
    });
    await db.insert(kilo_pass_issuances).values({
      id: issuanceId,
      kilo_pass_subscription_id: subscriptionId,
      issue_month: '2026-06-01',
      source: KiloPassIssuanceSource.StripeInvoice,
    });
    await webPurchase(user.id, { id: subscriptionCreditId });
    await db.insert(kilo_pass_issuance_items).values({
      kilo_pass_issuance_id: issuanceId,
      kind: KiloPassIssuanceItemKind.Base,
      credit_transaction_id: subscriptionCreditId,
      amount_usd: 10,
    });
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail.mock.calls).toEqual([[user.google_user_email]]);
  });

  it('never duplicates a send on overlapping crons, repeated receipts or a second store purchase', async () => {
    const first = await grant();
    await completeStoreCreditPurchase(first);
    await grant({
      user: first.user,
      purchaseFields: {
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        productId: 'credits_usd10',
        providerTransactionId: `GPA.${crypto.randomUUID()}`,
      },
    });
    const started = Promise.withResolvers<void>();
    const mayFinish = Promise.withResolvers<void>();
    const sendEmail = recordingSender().mockImplementation(async () => {
      started.resolve();
      await mayFinish.promise;
      return { sent: true };
    });
    const firstCron = dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    await started.promise;
    try {
      await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(await markersFor(first.user.id)).toHaveLength(1);
    } finally {
      mayFinish.resolve();
    }
    await firstCron;
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('drains a bounded batch without already claimed users starving the next run', async () => {
    const users = await Promise.all([grant(), grant(), grant()]);
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, limit: 2, sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    await dispatchStoreCreditWebTipEmails({ now: NOW, limit: 2, sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(new Set(sendEmail.mock.calls.map(([to]) => to))).toEqual(
      new Set(users.map(({ user }) => user.google_user_email))
    );
  });

  it('stops at the runtime boundary without claiming recipients needed by the next run', async () => {
    const users = await Promise.all([grant(), grant()]);
    let elapsedMs = 0;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const sendEmail = recordingSender().mockImplementation(async () => {
      elapsedMs = 180_000;
      return { sent: true };
    });
    try {
      const firstRun = await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
      expect(firstRun).toMatchObject({ selected: 2, claimed: 1, sent: 1 });
      const firstEmail = sendEmail.mock.calls[0]?.[0];
      const waiting = users.find(({ user }) => user.google_user_email !== firstEmail);
      if (!firstEmail || !waiting)
        throw new Error('Expected one delivered and one waiting recipient');
      expect(await markersFor(waiting.user.id)).toEqual([]);

      await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
      expect(sendEmail.mock.calls).toEqual([[firstEmail], [waiting.user.google_user_email]]);
      expect(await markersFor(waiting.user.id)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not backfill pre-feature production buyers or schedule sandbox purchases', async () => {
    const oldBuyer = await grant();
    await db
      .update(kilo_pass_audit_log)
      .set({ payload_json: sql`${kilo_pass_audit_log.payload_json} - 'firstCreditPackPurchase'` })
      .where(eq(kilo_pass_audit_log.kilo_user_id, oldBuyer.user.id));
    await grant({ user: oldBuyer.user });
    await grant({ purchaseFields: { environment: 'Sandbox' } });
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await markersFor(oldBuyer.user.id)).toEqual([]);
  });

  it.each([
    { blocked_reason: 'Blocked for abuse' },
    { is_bot: true },
    { personal_account_disabled: true },
    { account_deletion_requested_at: NOW.toISOString() },
  ] satisfies Partial<User>[])('excludes ineligible accounts: %j', async userFields => {
    const { user } = await grant({ userFields });
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await markersFor(user.id)).toEqual([]);
  });

  it.each(['charge', 'payment_intent', 'coinbase'])(
    'excludes previous web one-off purchasers via %s',
    async kind => {
      const { user } = await grant();
      await webPurchase(
        user.id,
        kind === 'payment_intent'
          ? { stripe_payment_id: `pi_${crypto.randomUUID()}` }
          : kind === 'coinbase'
            ? { stripe_payment_id: null, coinbase_credit_block_id: `block-${crypto.randomUUID()}` }
            : {}
      );
      const sendEmail = recordingSender();
      await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(await markersFor(user.id)).toEqual([]);
    }
  );

  it('does not mistake subscription invoice grants or promotional credits for web one-off purchases', async () => {
    const { user } = await grant();
    await webPurchase(user.id, { stripe_payment_id: `in_${crypto.randomUUID()}` });
    await webPurchase(user.id, { is_free: true });
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail.mock.calls).toEqual([[user.google_user_email]]);
  });

  it('suppresses an effective refund even when no clawback was written', async () => {
    const { user, purchase } = await grant();
    await refundEvent(purchase);
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    // A claimed but now-refunded candidate is terminal, not a repeated send attempt.
    expect(await markersFor(user.id)).toHaveLength(1);
  });

  it('ignores unprocessed refund notifications', async () => {
    const { user, purchase } = await grant();
    await refundEvent(purchase, { processed: false });
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail.mock.calls).toEqual([[user.google_user_email]]);
  });

  it('honors a newer reversal even if an older refund notification was processed afterward', async () => {
    const { user, purchase } = await grant();
    await refundEvent(purchase, {
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      signedDate: NOW.getTime(),
    });
    await refundEvent(purchase, { signedDate: NOW.getTime() - 60_000 });
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail.mock.calls).toEqual([[user.google_user_email]]);
  });

  it('allows a refund the store reinstated and whose ledger clawback was restored', async () => {
    const { user, purchase } = await grant();
    await refundEvent(purchase);
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: purchase.paymentProvider,
        providerTransactionId: purchase.providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );
    await db.transaction(tx =>
      restoreStoreCreditPurchase(tx, {
        paymentProvider: purchase.paymentProvider,
        providerTransactionId: purchase.providerTransactionId,
      })
    );
    await refundEvent(purchase, {
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      signedDate: NOW.getTime(),
    });
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail.mock.calls).toEqual([[user.google_user_email]]);
  });

  it('suppresses a Google digest grant through its clawback when the event uses a different order ID', async () => {
    const purchaseToken = `test-token-${crypto.randomUUID()}`;
    const { user, purchase } = await grant({
      purchaseFields: {
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        productId: 'credits_usd10',
        providerTransactionId: googlePlayCreditProviderTransactionId({ purchaseToken }),
        googlePlayPurchaseToken: purchaseToken,
      },
    });
    await refundEvent(purchase, {
      notificationType: 'voided_purchase',
      providerTransactionId: `GPA.${crypto.randomUUID()}`,
      providerSubscriptionId: purchaseToken,
    });
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: purchase.paymentProvider,
        providerTransactionId: purchase.providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );
    const sendEmail = recordingSender();
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await markersFor(user.id)).toEqual([]);
  });

  it.each(['blocked', 'refunded', 'web_purchase'])(
    'rechecks %s while processing a selected batch',
    async change => {
      const first = await grant({
        grantedAt: new Date(new Date(DUE_AT).getTime() - 60_000).toISOString(),
      });
      const second = await grant();
      const sendEmail = recordingSender().mockImplementation(async to => {
        if (to === first.user.google_user_email) {
          if (change === 'blocked') {
            await db
              .update(kilocode_users)
              .set({ blocked_reason: 'Newly blocked' })
              .where(eq(kilocode_users.id, second.user.id));
          } else if (change === 'refunded') {
            await refundEvent(second.purchase);
          } else {
            await webPurchase(second.user.id);
          }
        }
        return { sent: true };
      });
      await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
      expect(sendEmail.mock.calls).toEqual([[first.user.google_user_email]]);
    }
  );

  it('uses the current email address rather than the selected stale address', async () => {
    const first = await grant({
      grantedAt: new Date(new Date(DUE_AT).getTime() - 60_000).toISOString(),
    });
    const second = await grant();
    const currentEmail = `updated-${crypto.randomUUID()}@example.com`;
    const sendEmail = recordingSender().mockImplementation(async to => {
      if (to === first.user.google_user_email) {
        await db
          .update(kilocode_users)
          .set({ google_user_email: currentEmail })
          .where(eq(kilocode_users.id, second.user.id));
      }
      return { sent: true };
    });
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail.mock.calls).toEqual([[first.user.google_user_email], [currentEmail]]);
  });

  it('releases only known provider absence so a configured later run can deliver', async () => {
    const { user } = await grant();
    const sendEmail = recordingSender().mockResolvedValueOnce({
      sent: false,
      reason: 'provider_not_configured',
    });
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(await markersFor(user.id)).toEqual([]);
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(await markersFor(user.id)).toHaveLength(1);
  });

  it('keeps ambiguous failure claims and continues delivering other credited users', async () => {
    const failed = await grant({
      grantedAt: new Date(new Date(DUE_AT).getTime() - 60_000).toISOString(),
    });
    const delivered = await grant();
    const sendEmail = recordingSender().mockRejectedValueOnce(
      new Error('provider timed out after accepting')
    );
    const summary = await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(summary).toMatchObject({ errors: 1, sent: 1 });
    expect(sendEmail.mock.calls).toEqual([
      [failed.user.google_user_email],
      [delivered.user.google_user_email],
    ]);
    expect(await markersFor(failed.user.id)).toHaveLength(1);
    expect(failed.result).toMatchObject({
      alreadyProcessed: false,
      amountMicrodollars: toMicrodollars(10),
    });
    const current = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, failed.user.id),
    });
    expect(current?.total_microdollars_acquired).toBe(toMicrodollars(10));
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('does not retry a terminal rejected email address', async () => {
    const { user } = await grant();
    const sendEmail = recordingSender().mockResolvedValue({
      sent: false,
      reason: 'neverbounce_rejected',
    });
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    await dispatchStoreCreditWebTipEmails({ now: NOW, sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await markersFor(user.id)).toHaveLength(1);
  });
});
