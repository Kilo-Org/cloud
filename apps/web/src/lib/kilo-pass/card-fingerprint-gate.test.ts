import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  kilo_pass_accepted_card_purchases,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  transactional_email_log,
} from '@kilocode/db/schema';
import {
  KiloPassCadence,
  KiloPassIssuanceSource,
  KiloPassPaymentProvider,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import type { SettledInvoicePaymentResolution } from '@/lib/kilo-pass/stripe-handlers-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import {
  acquireDuplicateCardSubscriptionLock,
  attemptDuplicateCardProviderEnforcement,
  checkDuplicateCardFingerprintGate,
  digestCardFingerprint,
  loadDuplicateCardReplayAuthority,
  maybeSendDuplicateCardCanceledEmail,
  type DuplicateCardGateResult,
} from './card-fingerprint-gate';

function makeInvoice(params: { id: string; purchasedAt: string }): Stripe.Invoice {
  const timestampSeconds = Math.floor(new Date(params.purchasedAt).getTime() / 1000);
  return {
    id: params.id,
    created: timestampSeconds,
    status_transitions: { paid_at: timestampSeconds },
  } as unknown as Stripe.Invoice;
}

function cardSettlement(
  fingerprint: string,
  refundableTarget: { kind: 'payment_intent' | 'charge'; id: string } | null = {
    kind: 'payment_intent',
    id: 'pi_test',
  }
): SettledInvoicePaymentResolution {
  return {
    kind: 'settled',
    paymentMethod: { kind: 'reusable', paymentMethodType: 'card', fingerprint },
    refundableTarget,
  };
}

async function runGate(params: {
  invoiceId: string;
  stripeSubscriptionId: string;
  kiloUserId: string;
  purchasedAt: string;
  settlement: SettledInvoicePaymentResolution;
}): Promise<DuplicateCardGateResult> {
  return await db.transaction(async tx => {
    await acquireDuplicateCardSubscriptionLock(tx, params.stripeSubscriptionId);
    return await checkDuplicateCardFingerprintGate({
      tx,
      invoice: makeInvoice({ id: params.invoiceId, purchasedAt: params.purchasedAt }),
      stripeSubscriptionId: params.stripeSubscriptionId,
      kiloUserId: params.kiloUserId,
      getSettledPaymentResolution: async () => params.settlement,
    });
  });
}

beforeEach(async () => {
  await cleanupDbForTest();
});

describe('accepted-purchase duplicate-card arbitration', () => {
  test('accepts exact-card purchases and stores only fingerprint digest', async () => {
    const fingerprint = 'fp_transient_raw_value';
    const result = await runGate({
      invoiceId: 'in_first',
      stripeSubscriptionId: 'sub_first',
      kiloUserId: 'user_first',
      purchasedAt: '2026-06-05T12:00:00.000Z',
      settlement: cardSettlement(fingerprint),
    });

    expect(result).toEqual({ blocked: false, accepted: true });
    const record = await db.query.kilo_pass_accepted_card_purchases.findFirst({
      where: eq(kilo_pass_accepted_card_purchases.stripe_invoice_id, 'in_first'),
    });
    expect(record).toMatchObject({
      stripe_subscription_id: 'sub_first',
      kilo_user_id: 'user_first',
      fingerprint_digest: digestCardFingerprint(fingerprint),
    });
    expect(new Date(record?.purchased_at ?? '').toISOString()).toBe('2026-06-05T12:00:00.000Z');
    expect(JSON.stringify(record)).not.toContain(fingerprint);
  });

  test('allows same-user purchases and records newer evidence', async () => {
    const settlement = cardSettlement('fp_same_user');
    await runGate({
      invoiceId: 'in_same_user_first',
      stripeSubscriptionId: 'sub_same_user_first',
      kiloUserId: 'same_user',
      purchasedAt: '2026-06-05T12:00:00.000Z',
      settlement,
    });
    const second = await runGate({
      invoiceId: 'in_same_user_second',
      stripeSubscriptionId: 'sub_same_user_second',
      kiloUserId: 'same_user',
      purchasedAt: '2026-06-05T12:01:00.000Z',
      settlement,
    });

    expect(second).toEqual({ blocked: false, accepted: true });
    const records = await db.select().from(kilo_pass_accepted_card_purchases);
    expect(records).toHaveLength(2);
  });

  test('blocks different-user purchase less than 24 hours apart', async () => {
    const settlement = cardSettlement('fp_cross_user');
    await runGate({
      invoiceId: 'in_winner',
      stripeSubscriptionId: 'sub_winner',
      kiloUserId: 'winner_user',
      purchasedAt: '2026-06-04T12:00:00.000Z',
      settlement,
    });
    const blocked = await runGate({
      invoiceId: 'in_blocked',
      stripeSubscriptionId: 'sub_blocked',
      kiloUserId: 'blocked_user',
      purchasedAt: '2026-06-05T11:59:59.000Z',
      settlement,
    });

    expect(blocked).toMatchObject({
      blocked: true,
      fingerprintDigest: digestCardFingerprint('fp_cross_user'),
      matchedKiloUserId: 'winner_user',
      matchedStripeSubscriptionId: 'sub_winner',
      matchedStripeInvoiceId: 'in_winner',
    });
    expect(await db.select().from(kilo_pass_accepted_card_purchases)).toHaveLength(1);
  });

  test('allows different-user purchase exactly 24 hours apart', async () => {
    const settlement = cardSettlement('fp_boundary');
    await runGate({
      invoiceId: 'in_boundary_first',
      stripeSubscriptionId: 'sub_boundary_first',
      kiloUserId: 'boundary_user_first',
      purchasedAt: '2026-06-04T12:00:00.000Z',
      settlement,
    });
    const result = await runGate({
      invoiceId: 'in_boundary_second',
      stripeSubscriptionId: 'sub_boundary_second',
      kiloUserId: 'boundary_user_second',
      purchasedAt: '2026-06-05T12:00:00.000Z',
      settlement,
    });

    expect(result).toEqual({ blocked: false, accepted: true });
    expect(await db.select().from(kilo_pass_accepted_card_purchases)).toHaveLength(2);
  });

  test('chooses nearest purchase then invoice ID as deterministic tiebreaker', async () => {
    const fingerprintDigest = digestCardFingerprint('fp_nearest');
    await db.insert(kilo_pass_accepted_card_purchases).values([
      {
        stripe_invoice_id: 'in_z_far',
        stripe_subscription_id: 'sub_z_far',
        kilo_user_id: 'user_z_far',
        fingerprint_digest: fingerprintDigest,
        purchased_at: '2026-06-05T10:00:00.000Z',
      },
      {
        stripe_invoice_id: 'in_b_near',
        stripe_subscription_id: 'sub_b_near',
        kilo_user_id: 'user_b_near',
        fingerprint_digest: fingerprintDigest,
        purchased_at: '2026-06-05T11:59:00.000Z',
      },
      {
        stripe_invoice_id: 'in_a_near',
        stripe_subscription_id: 'sub_a_near',
        kilo_user_id: 'user_a_near',
        fingerprint_digest: fingerprintDigest,
        purchased_at: '2026-06-05T12:01:00.000Z',
      },
    ]);

    const result = await runGate({
      invoiceId: 'in_candidate',
      stripeSubscriptionId: 'sub_candidate',
      kiloUserId: 'candidate_user',
      purchasedAt: '2026-06-05T12:00:00.000Z',
      settlement: cardSettlement('fp_nearest'),
    });

    expect(result).toMatchObject({ blocked: true, matchedStripeInvoiceId: 'in_a_near' });
  });

  test('fails open without history for unsupported evidence and future timestamps', async () => {
    const futureTimestamp = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    const futureResolution = jest.fn(async () => cardSettlement('fp_future'));
    const futureResult = await db.transaction(async tx => {
      await acquireDuplicateCardSubscriptionLock(tx, 'sub_future');
      return await checkDuplicateCardFingerprintGate({
        tx,
        invoice: makeInvoice({ id: 'in_future', purchasedAt: futureTimestamp }),
        stripeSubscriptionId: 'sub_future',
        kiloUserId: 'user_future',
        getSettledPaymentResolution: futureResolution,
      });
    });
    const bankResult = await runGate({
      invoiceId: 'in_bank',
      stripeSubscriptionId: 'sub_bank',
      kiloUserId: 'user_bank',
      purchasedAt: '2026-06-05T12:00:00.000Z',
      settlement: {
        kind: 'settled',
        paymentMethod: {
          kind: 'reusable',
          paymentMethodType: 'sepa_debit',
          fingerprint: 'bank_fp',
        },
        refundableTarget: { kind: 'payment_intent', id: 'pi_bank' },
      },
    });

    expect(futureResult).toEqual({ blocked: false, accepted: false });
    expect(futureResolution).not.toHaveBeenCalled();
    expect(bankResult).toEqual({ blocked: false, accepted: false });
    expect(await db.select().from(kilo_pass_accepted_card_purchases)).toHaveLength(0);
  });

  test('serializes concurrent cross-user purchases so one purchase wins', async () => {
    const settlement = cardSettlement('fp_concurrent');
    const results = await Promise.all([
      runGate({
        invoiceId: 'in_concurrent_a',
        stripeSubscriptionId: 'sub_concurrent_a',
        kiloUserId: 'user_concurrent_a',
        purchasedAt: '2026-06-05T12:00:00.000Z',
        settlement,
      }),
      runGate({
        invoiceId: 'in_concurrent_b',
        stripeSubscriptionId: 'sub_concurrent_b',
        kiloUserId: 'user_concurrent_b',
        purchasedAt: '2026-06-05T12:00:00.000Z',
        settlement,
      }),
    ]);

    expect(results.filter(result => result.blocked)).toHaveLength(1);
    expect(results.filter(result => !result.blocked && result.accepted)).toHaveLength(1);
    expect(await db.select().from(kilo_pass_accepted_card_purchases)).toHaveLength(1);
  });
});

describe('duplicate-card replay authority', () => {
  test('accepts exact accepted-record replay without settlement re-resolution', async () => {
    await db.insert(kilo_pass_accepted_card_purchases).values({
      stripe_invoice_id: 'in_replay',
      stripe_subscription_id: 'sub_replay',
      kilo_user_id: 'user_replay',
      fingerprint_digest: digestCardFingerprint('fp_replay'),
      purchased_at: '2026-06-05T12:00:00.000Z',
    });

    const authority = await db.transaction(async tx => {
      await acquireDuplicateCardSubscriptionLock(tx, 'sub_replay');
      return await loadDuplicateCardReplayAuthority({
        tx,
        stripeInvoiceId: 'in_replay',
        stripeSubscriptionId: 'sub_replay',
        kiloUserId: 'user_replay',
      });
    });
    expect(authority).toBe('accepted');
  });

  test('uses matching committed issuance as fail-open replay authority', async () => {
    const user = await insertTestUser();
    const [subscription] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        payment_provider: KiloPassPaymentProvider.Stripe,
        provider_subscription_id: 'sub_fail_open',
        stripe_subscription_id: 'sub_fail_open',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      })
      .returning({ id: kilo_pass_subscriptions.id });
    await db.insert(kilo_pass_issuances).values({
      kilo_pass_subscription_id: subscription.id,
      issue_month: '2026-06-01',
      source: KiloPassIssuanceSource.StripeInvoice,
      stripe_invoice_id: 'in_fail_open',
    });

    const authority = await db.transaction(async tx => {
      await acquireDuplicateCardSubscriptionLock(tx, 'sub_fail_open');
      return await loadDuplicateCardReplayAuthority({
        tx,
        stripeInvoiceId: 'in_fail_open',
        stripeSubscriptionId: 'sub_fail_open',
        kiloUserId: user.id,
      });
    });
    expect(authority).toBe('fail_open');
  });

  test('throws on accepted-record attribution conflicts', async () => {
    await db.insert(kilo_pass_accepted_card_purchases).values({
      stripe_invoice_id: 'in_recorded',
      stripe_subscription_id: 'sub_recorded',
      kilo_user_id: 'recorded_user',
      fingerprint_digest: digestCardFingerprint('fp_recorded'),
      purchased_at: '2026-06-05T12:00:00.000Z',
    });

    await expect(
      db.transaction(async tx => {
        await acquireDuplicateCardSubscriptionLock(tx, 'sub_recorded');
        return await loadDuplicateCardReplayAuthority({
          tx,
          stripeInvoiceId: 'in_conflict',
          stripeSubscriptionId: 'sub_recorded',
          kiloUserId: 'recorded_user',
        });
      })
    ).rejects.toThrow('replay attribution conflict');
  });
});

describe('duplicate-card provider enforcement and email', () => {
  const gateResult: Extract<DuplicateCardGateResult, { blocked: true }> = {
    blocked: true,
    fingerprintDigest: 'c'.repeat(64),
    matchedKiloUserId: 'matched_user',
    matchedStripeSubscriptionId: 'sub_matched',
    matchedStripeInvoiceId: 'in_matched',
    matchedPurchasedAt: '2026-06-05T12:00:00.000Z',
    refundableTarget: { kind: 'charge', id: 'ch_exact' },
  };

  test('cancels and refunds exact settlement with deterministic idempotency keys', async () => {
    const cancel = jest.fn(async (...args: unknown[]) => {
      void args;
      return { id: 'sub_blocked' };
    });
    const createRefund = jest.fn(async (...args: unknown[]) => {
      void args;
      return { id: 're_blocked' };
    });

    await attemptDuplicateCardProviderEnforcement({
      stripe: {
        subscriptions: { cancel },
        refunds: { create: createRefund },
      } as unknown as Stripe,
      stripeInvoiceId: 'in_blocked',
      stripeSubscriptionId: 'sub_blocked',
      kiloUserId: 'blocked_user',
      gateResult,
    });

    expect(cancel).toHaveBeenCalledWith(
      'sub_blocked',
      { invoice_now: false, prorate: false },
      { idempotencyKey: 'kilo-pass-duplicate-card-cancel:in_blocked' }
    );
    expect(createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ charge: 'ch_exact', reason: 'duplicate' }),
      { idempotencyKey: 'kilo-pass-duplicate-card-refund:in_blocked' }
    );
  });

  test('provider failures and missing refund target do not throw', async () => {
    const providerError = new Error('provider unavailable');
    await expect(
      attemptDuplicateCardProviderEnforcement({
        stripe: {
          subscriptions: { cancel: jest.fn(async () => Promise.reject(providerError)) },
          refunds: { create: jest.fn(async () => Promise.reject(providerError)) },
        } as unknown as Stripe,
        stripeInvoiceId: 'in_provider_failure',
        stripeSubscriptionId: 'sub_provider_failure',
        kiloUserId: 'user_provider_failure',
        gateResult: { ...gateResult, refundableTarget: null },
      })
    ).resolves.toBeUndefined();
  });

  test('clears email marker when provider is unavailable so replay can retry', async () => {
    const user = await insertTestUser();
    await maybeSendDuplicateCardCanceledEmail({ kiloUserId: user.id, stripeInvoiceId: 'in_email' });

    const markers = await db
      .select()
      .from(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, 'in_email'));
    expect(markers).toHaveLength(0);
  });
});
