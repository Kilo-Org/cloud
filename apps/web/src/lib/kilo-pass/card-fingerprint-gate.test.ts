import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  kilo_pass_audit_log,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilo_pass_welcome_promo_payment_fingerprint_claims,
  transactional_email_log,
} from '@kilocode/db/schema';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassCadence,
  KiloPassIssuanceSource,
  KiloPassPaymentProvider,
  KiloPassTier,
  KiloPassWelcomePromoEligibilityReason,
  KiloPassWelcomePromoPaymentFingerprintType,
} from '@/lib/kilo-pass/enums';
import type { SettledInvoicePaymentResolution } from '@/lib/kilo-pass/stripe-handlers-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import {
  acquireDuplicateCardSubscriptionLock,
  attemptDuplicateCardProviderEnforcement,
  checkDuplicateCardFingerprintGate,
  claimPaymentFingerprint,
  digestCardFingerprint,
  loadDuplicateCardReplayAuthority,
  maybeSendDuplicateCardCanceledEmail,
  type DuplicateCardGateResult,
} from './card-fingerprint-gate';

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

async function insertSubscriptionAttribution(params: {
  kiloUserId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string;
  cadence?: KiloPassCadence;
}): Promise<void> {
  const [subscription] = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: params.kiloUserId,
      payment_provider: KiloPassPaymentProvider.Stripe,
      provider_subscription_id: params.stripeSubscriptionId,
      stripe_subscription_id: params.stripeSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: params.cadence ?? KiloPassCadence.Monthly,
      status: 'active',
    })
    .returning({ id: kilo_pass_subscriptions.id });
  await db.insert(kilo_pass_issuances).values({
    kilo_pass_subscription_id: subscription.id,
    issue_month: '2026-06-01',
    source: KiloPassIssuanceSource.StripeInvoice,
    stripe_invoice_id: params.stripeInvoiceId,
  });
}

async function insertFirstClaim(params: {
  fingerprint: string;
  kiloUserId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string;
  cadence?: KiloPassCadence;
}): Promise<void> {
  await insertSubscriptionAttribution(params);
  await db.insert(kilo_pass_welcome_promo_payment_fingerprint_claims).values({
    stripe_payment_method_type: KiloPassWelcomePromoPaymentFingerprintType.Card,
    stripe_fingerprint: params.fingerprint,
    source_stripe_invoice_id: params.stripeInvoiceId,
  });
}

async function evaluateExistingClaim(params: {
  fingerprint: string;
  candidateKiloUserId: string;
  candidateStripeInvoiceId: string;
}): Promise<DuplicateCardGateResult> {
  return await db.transaction(async tx => {
    const claimResult = await claimPaymentFingerprint({
      tx,
      stripeInvoiceId: params.candidateStripeInvoiceId,
      settlement: cardSettlement(params.fingerprint),
    });
    return await checkDuplicateCardFingerprintGate({
      tx,
      kiloUserId: params.candidateKiloUserId,
      claimResult,
    });
  });
}

beforeEach(async () => {
  await cleanupDbForTest();
});

describe('first-fingerprint-claim cooldown', () => {
  test('first exact-card claim is allowed and supplies welcome-promo decision', async () => {
    const fingerprint = 'fp_first_claim';
    const result = await db.transaction(async tx => {
      const claimResult = await claimPaymentFingerprint({
        tx,
        stripeInvoiceId: 'in_first_claim',
        settlement: cardSettlement(fingerprint),
      });
      return {
        claimResult,
        gateResult: await checkDuplicateCardFingerprintGate({
          tx,
          kiloUserId: 'first_user',
          claimResult,
        }),
      };
    });

    expect(result.gateResult).toEqual({ blocked: false });
    expect(result.claimResult).toMatchObject({
      welcomePromoReason: KiloPassWelcomePromoEligibilityReason.FirstPaymentFingerprintClaim,
      cardClaim: {
        ownership: 'current_invoice',
        sourceStripeInvoiceId: 'in_first_claim',
        fingerprintDigest: digestCardFingerprint(fingerprint),
      },
    });
    const claim = await db.query.kilo_pass_welcome_promo_payment_fingerprint_claims.findFirst({
      where: eq(kilo_pass_welcome_promo_payment_fingerprint_claims.stripe_fingerprint, fingerprint),
    });
    expect(claim?.source_stripe_invoice_id).toBe('in_first_claim');
  });

  test('allows same-user reuse without refreshing permanent claim', async () => {
    const user = await insertTestUser();
    await insertFirstClaim({
      fingerprint: 'fp_same_user',
      kiloUserId: user.id,
      stripeSubscriptionId: 'sub_same_user_first',
      stripeInvoiceId: 'in_same_user_first',
    });
    const before = await db.query.kilo_pass_welcome_promo_payment_fingerprint_claims.findFirst({
      where: eq(
        kilo_pass_welcome_promo_payment_fingerprint_claims.stripe_fingerprint,
        'fp_same_user'
      ),
    });

    const result = await evaluateExistingClaim({
      fingerprint: 'fp_same_user',
      candidateKiloUserId: user.id,
      candidateStripeInvoiceId: 'in_same_user_second',
    });

    expect(result).toEqual({ blocked: false });
    const after = await db.query.kilo_pass_welcome_promo_payment_fingerprint_claims.findFirst({
      where: eq(
        kilo_pass_welcome_promo_payment_fingerprint_claims.stripe_fingerprint,
        'fp_same_user'
      ),
    });
    expect(after).toEqual(before);
  });

  test('blocks different-user reuse while first claim is under 24 hours old', async () => {
    const firstUser = await insertTestUser();
    const candidateUser = await insertTestUser();
    await insertFirstClaim({
      fingerprint: 'fp_cross_user',
      kiloUserId: firstUser.id,
      stripeSubscriptionId: 'sub_first_claimant',
      stripeInvoiceId: 'in_first_claimant',
    });

    const result = await evaluateExistingClaim({
      fingerprint: 'fp_cross_user',
      candidateKiloUserId: candidateUser.id,
      candidateStripeInvoiceId: 'in_candidate',
    });

    expect(result).toMatchObject({
      blocked: true,
      fingerprintDigest: digestCardFingerprint('fp_cross_user'),
      firstClaimSourceStripeInvoiceId: 'in_first_claimant',
      matchedKiloUserId: firstUser.id,
      matchedStripeSubscriptionId: 'sub_first_claimant',
    });
  });

  test('uses a yearly issuance to attribute the first claimant', async () => {
    const firstUser = await insertTestUser();
    const candidateUser = await insertTestUser();
    await insertFirstClaim({
      fingerprint: 'fp_yearly_first_claim',
      kiloUserId: firstUser.id,
      stripeSubscriptionId: 'sub_yearly_first_claim',
      stripeInvoiceId: 'in_yearly_first_claim',
      cadence: KiloPassCadence.Yearly,
    });

    const result = await evaluateExistingClaim({
      fingerprint: 'fp_yearly_first_claim',
      candidateKiloUserId: candidateUser.id,
      candidateStripeInvoiceId: 'in_monthly_candidate',
    });

    expect(result).toMatchObject({
      blocked: true,
      firstClaimSourceStripeInvoiceId: 'in_yearly_first_claim',
      matchedKiloUserId: firstUser.id,
      matchedStripeSubscriptionId: 'sub_yearly_first_claim',
    });
  });

  test.each([
    ['exactly 24 hours', sql`transaction_timestamp() - interval '24 hours'`],
    ['more than 24 hours', sql`transaction_timestamp() - interval '25 hours'`],
  ])('allows different-user reuse at %s without refreshing claim', async (_label, claimedAt) => {
    const firstUser = await insertTestUser();
    const candidateUser = await insertTestUser();
    await insertFirstClaim({
      fingerprint: 'fp_elapsed',
      kiloUserId: firstUser.id,
      stripeSubscriptionId: 'sub_elapsed_first',
      stripeInvoiceId: 'in_elapsed_first',
    });

    const result = await db.transaction(async tx => {
      await tx
        .update(kilo_pass_welcome_promo_payment_fingerprint_claims)
        .set({ claimed_at: claimedAt })
        .where(
          eq(kilo_pass_welcome_promo_payment_fingerprint_claims.stripe_fingerprint, 'fp_elapsed')
        );
      const claimResult = await claimPaymentFingerprint({
        tx,
        stripeInvoiceId: 'in_elapsed_candidate',
        settlement: cardSettlement('fp_elapsed'),
      });
      const gateResult = await checkDuplicateCardFingerprintGate({
        tx,
        kiloUserId: candidateUser.id,
        claimResult,
      });
      return { claimResult, gateResult };
    });

    expect(result.gateResult).toEqual({ blocked: false });
    expect(result.claimResult.welcomePromoReason).toBe(
      KiloPassWelcomePromoEligibilityReason.FingerprintPreviouslyClaimed
    );
    const claim = await db.query.kilo_pass_welcome_promo_payment_fingerprint_claims.findFirst({
      where: eq(
        kilo_pass_welcome_promo_payment_fingerprint_claims.stripe_fingerprint,
        'fp_elapsed'
      ),
    });
    expect(claim?.source_stripe_invoice_id).toBe('in_elapsed_first');
  });

  test('fails open when first claim cannot be attributed through an issuance', async () => {
    await db.insert(kilo_pass_welcome_promo_payment_fingerprint_claims).values({
      stripe_payment_method_type: KiloPassWelcomePromoPaymentFingerprintType.Card,
      stripe_fingerprint: 'fp_unattributed',
      source_stripe_invoice_id: 'in_unattributed',
    });

    await expect(
      evaluateExistingClaim({
        fingerprint: 'fp_unattributed',
        candidateKiloUserId: 'candidate_user',
        candidateStripeInvoiceId: 'in_candidate',
      })
    ).resolves.toEqual({ blocked: false });
  });

  test('non-card claims retain welcome-promo behavior without cancellation enforcement', async () => {
    const result = await db.transaction(async tx => {
      const claimResult = await claimPaymentFingerprint({
        tx,
        stripeInvoiceId: 'in_bank',
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
      return {
        claimResult,
        gateResult: await checkDuplicateCardFingerprintGate({
          tx,
          kiloUserId: 'bank_user',
          claimResult,
        }),
      };
    });

    expect(result.gateResult).toEqual({ blocked: false });
    expect(result.claimResult).toEqual({
      welcomePromoReason: KiloPassWelcomePromoEligibilityReason.FirstPaymentFingerprintClaim,
      cardClaim: null,
    });
  });

  test('serializes concurrent different-user claims so one first claimant wins', async () => {
    const firstUser = await insertTestUser();
    const secondUser = await insertTestUser();
    const [firstSubscription, secondSubscription] = await Promise.all([
      db
        .insert(kilo_pass_subscriptions)
        .values({
          kilo_user_id: firstUser.id,
          payment_provider: KiloPassPaymentProvider.Stripe,
          provider_subscription_id: 'sub_concurrent_first',
          stripe_subscription_id: 'sub_concurrent_first',
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
          status: 'active',
        })
        .returning({ id: kilo_pass_subscriptions.id }),
      db
        .insert(kilo_pass_subscriptions)
        .values({
          kilo_user_id: secondUser.id,
          payment_provider: KiloPassPaymentProvider.Stripe,
          provider_subscription_id: 'sub_concurrent_second',
          stripe_subscription_id: 'sub_concurrent_second',
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
          status: 'active',
        })
        .returning({ id: kilo_pass_subscriptions.id }),
    ]);
    const candidates = [
      {
        kiloUserId: firstUser.id,
        subscriptionId: firstSubscription[0].id,
        stripeSubscriptionId: 'sub_concurrent_first',
        stripeInvoiceId: 'in_concurrent_first',
      },
      {
        kiloUserId: secondUser.id,
        subscriptionId: secondSubscription[0].id,
        stripeSubscriptionId: 'sub_concurrent_second',
        stripeInvoiceId: 'in_concurrent_second',
      },
    ];

    const results = await Promise.all(
      candidates.map(
        async candidate =>
          await db.transaction(async tx => {
            await acquireDuplicateCardSubscriptionLock(tx, candidate.stripeSubscriptionId);
            const claimResult = await claimPaymentFingerprint({
              tx,
              stripeInvoiceId: candidate.stripeInvoiceId,
              settlement: cardSettlement('fp_concurrent'),
            });
            const gateResult = await checkDuplicateCardFingerprintGate({
              tx,
              kiloUserId: candidate.kiloUserId,
              claimResult,
            });
            if (!gateResult.blocked) {
              await tx.insert(kilo_pass_issuances).values({
                kilo_pass_subscription_id: candidate.subscriptionId,
                issue_month: '2026-06-01',
                source: KiloPassIssuanceSource.StripeInvoice,
                stripe_invoice_id: candidate.stripeInvoiceId,
              });
            }
            return gateResult;
          })
      )
    );

    expect(results.filter(result => result.blocked)).toHaveLength(1);
    expect(results.filter(result => !result.blocked)).toHaveLength(1);
    expect(await db.select().from(kilo_pass_welcome_promo_payment_fingerprint_claims)).toHaveLength(
      1
    );
  });
});

describe('duplicate-card replay authority', () => {
  test('uses matching committed issuance as allowed replay authority', async () => {
    const user = await insertTestUser();
    await insertSubscriptionAttribution({
      kiloUserId: user.id,
      stripeSubscriptionId: 'sub_allowed_replay',
      stripeInvoiceId: 'in_allowed_replay',
    });

    const authority = await db.transaction(
      async tx =>
        await loadDuplicateCardReplayAuthority({
          tx,
          stripeInvoiceId: 'in_allowed_replay',
          stripeSubscriptionId: 'sub_allowed_replay',
          kiloUserId: user.id,
        })
    );

    expect(authority).toMatchObject({ kind: 'allowed' });
  });

  test('uses exact invoice authority after later subscription issuances', async () => {
    const user = await insertTestUser();
    await insertSubscriptionAttribution({
      kiloUserId: user.id,
      stripeSubscriptionId: 'sub_late_replay',
      stripeInvoiceId: 'in_initial',
    });
    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      columns: { id: true },
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_late_replay'),
    });
    if (!subscription) throw new Error('Expected late-replay test subscription');
    await db.insert(kilo_pass_issuances).values({
      kilo_pass_subscription_id: subscription.id,
      issue_month: '2026-07-01',
      source: KiloPassIssuanceSource.StripeInvoice,
      stripe_invoice_id: 'in_renewal',
    });

    const authority = await db.transaction(
      async tx =>
        await loadDuplicateCardReplayAuthority({
          tx,
          stripeInvoiceId: 'in_initial',
          stripeSubscriptionId: 'sub_late_replay',
          kiloUserId: user.id,
        })
    );

    expect(authority).toMatchObject({ kind: 'allowed' });
  });

  test('uses successful duplicate-block audit as permanent blocked replay authority', async () => {
    const user = await insertTestUser();
    await db.insert(kilo_pass_audit_log).values({
      action: KiloPassAuditLogAction.DuplicateCardSubscriptionCanceled,
      result: KiloPassAuditLogResult.Success,
      kilo_user_id: user.id,
      stripe_invoice_id: 'in_blocked_replay',
      stripe_subscription_id: 'sub_blocked_replay',
      payload_json: {
        fingerprintDigest: 'd'.repeat(64),
        firstClaimSourceStripeInvoiceId: 'in_first_claim',
        firstClaimedAt: '2026-06-01T00:00:00.000Z',
        matchedKiloUserId: 'first_user',
        matchedStripeSubscriptionId: 'sub_first_user',
      },
    });

    const authority = await db.transaction(
      async tx =>
        await loadDuplicateCardReplayAuthority({
          tx,
          stripeInvoiceId: 'in_blocked_replay',
          stripeSubscriptionId: 'sub_blocked_replay',
          kiloUserId: user.id,
        })
    );

    expect(authority).toMatchObject({
      kind: 'blocked',
      gateResult: {
        blocked: true,
        fingerprintDigest: 'd'.repeat(64),
        firstClaimSourceStripeInvoiceId: 'in_first_claim',
      },
    });
  });

  test('blocked audit takes precedence over matching issuance', async () => {
    const user = await insertTestUser();
    await insertSubscriptionAttribution({
      kiloUserId: user.id,
      stripeSubscriptionId: 'sub_both_authorities',
      stripeInvoiceId: 'in_both_authorities',
    });
    await db.insert(kilo_pass_audit_log).values({
      action: KiloPassAuditLogAction.DuplicateCardSubscriptionCanceled,
      result: KiloPassAuditLogResult.Success,
      kilo_user_id: user.id,
      stripe_invoice_id: 'in_both_authorities',
      stripe_subscription_id: 'sub_both_authorities',
    });

    const authority = await db.transaction(
      async tx =>
        await loadDuplicateCardReplayAuthority({
          tx,
          stripeInvoiceId: 'in_both_authorities',
          stripeSubscriptionId: 'sub_both_authorities',
          kiloUserId: user.id,
        })
    );

    expect(authority.kind).toBe('blocked');
  });

  test('throws when replay records share subscription with conflicting invoice attribution', async () => {
    const user = await insertTestUser();
    await insertSubscriptionAttribution({
      kiloUserId: user.id,
      stripeSubscriptionId: 'sub_conflict',
      stripeInvoiceId: 'in_recorded',
    });

    await expect(
      db.transaction(
        async tx =>
          await loadDuplicateCardReplayAuthority({
            tx,
            stripeInvoiceId: 'in_conflict',
            stripeSubscriptionId: 'sub_conflict',
            kiloUserId: user.id,
          })
      )
    ).rejects.toThrow('replay attribution conflict');
  });
});

describe('duplicate-card provider enforcement and email', () => {
  const gateResult: Extract<DuplicateCardGateResult, { blocked: true }> = {
    blocked: true,
    fingerprintDigest: 'c'.repeat(64),
    firstClaimSourceStripeInvoiceId: 'in_first_claim',
    firstClaimedAt: '2026-06-05T12:00:00.000Z',
    matchedKiloUserId: 'matched_user',
    matchedStripeSubscriptionId: 'sub_matched',
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
