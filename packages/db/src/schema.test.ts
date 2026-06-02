import { afterAll, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from './schema';
import { SCHEMA_CHECK_ENUMS } from './schema';
import { createDrizzleClient } from './client';
import { computeDatabaseUrl } from './database-url';
import { KiloPassCadence, KiloPassPaymentProvider, KiloPassTier } from './schema-types';

const schemaTestDb = createDrizzleClient({
  connectionString: computeDatabaseUrl(),
  poolConfig: { application_name: 'db-schema-test', max: 1 },
});

afterAll(async () => {
  await schemaTestDb.pool.end();
});

async function withKiloPassTestUser(
  testFn: (params: { userId: string }) => Promise<void>
): Promise<void> {
  const userId = `schema-kilo-pass-${crypto.randomUUID()}`;

  await schemaTestDb.db.insert(schema.kilocode_users).values({
    id: userId,
    google_user_email: `${userId}@example.com`,
    google_user_name: 'Schema Test User',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${crypto.randomUUID()}`,
  });

  try {
    await testFn({ userId });
  } finally {
    await schemaTestDb.db.delete(schema.kilocode_users).where(eq(schema.kilocode_users.id, userId));
  }
}

async function insertKiloPassSubscription(values: {
  userId: string;
  paymentProvider: KiloPassPaymentProvider;
  providerSubscriptionId: string | null;
  stripeSubscriptionId: string | null;
}): Promise<string> {
  const [subscription] = await schemaTestDb.db
    .insert(schema.kilo_pass_subscriptions)
    .values({
      kilo_user_id: values.userId,
      payment_provider: values.paymentProvider,
      provider_subscription_id: values.providerSubscriptionId,
      stripe_subscription_id: values.stripeSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
    })
    .returning({ id: schema.kilo_pass_subscriptions.id });

  if (!subscription) {
    throw new Error('Failed to insert Kilo Pass subscription');
  }

  return subscription.id;
}

async function insertKiloPassStorePurchase(values: {
  subscriptionId: string;
  userId: string;
  paymentProvider: KiloPassPaymentProvider;
  providerSubscriptionId: string;
  providerTransactionId?: string;
}): Promise<void> {
  await schemaTestDb.db.insert(schema.kilo_pass_store_purchases).values({
    kilo_pass_subscription_id: values.subscriptionId,
    kilo_user_id: values.userId,
    payment_provider: values.paymentProvider,
    product_id: 'kilopass.tier19.monthly.v1',
    provider_subscription_id: values.providerSubscriptionId,
    provider_transaction_id: values.providerTransactionId ?? `tx-${crypto.randomUUID()}`,
    environment: 'Sandbox',
    purchased_at: '2026-05-01T00:00:00.000Z',
  });
}

async function expectProviderIdsCheckViolation(insertPromise: Promise<unknown>): Promise<void> {
  await expect(insertPromise).rejects.toMatchObject({
    cause: {
      constraint: 'kilo_pass_subscriptions_provider_ids_check',
    },
  });
}

async function expectStorePurchaseConstraintViolation(
  insertPromise: Promise<unknown>,
  constraint: string
): Promise<void> {
  await expect(insertPromise).rejects.toMatchObject({
    cause: {
      constraint,
    },
  });
}

describe('database schema', () => {
  it("should be up to date with migrations (run 'pnpm drizzle generate' if this fails)", async () => {
    const migrationsDir = path.join(__dirname, 'migrations');

    // Get the latest snapshot from the migrations folder
    const journalPath = path.join(migrationsDir, 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
      entries: { idx: number }[];
    };
    const latestEntry = journal.entries[journal.entries.length - 1];
    const latestSnapshotPath = path.join(
      migrationsDir,
      'meta',
      `${latestEntry.idx.toString().padStart(4, '0')}_snapshot.json`
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-redundant-type-constituents -- drizzle-kit API types
    const latestSnapshot: Parameters<typeof generateMigration>[0] & { id: string } = JSON.parse(
      fs.readFileSync(latestSnapshotPath, 'utf-8')
    );

    // Generate current schema state
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- drizzle-kit API types
    const currentSchema = generateDrizzleJson(schema, latestSnapshot.id);

    // Generate migration diff
    const migrationStatements = await generateMigration(latestSnapshot, currentSchema);

    const expect_unmigrated_changes = false;
    const has_unmigrated_changes = migrationStatements.length > 0;
    if (expect_unmigrated_changes !== has_unmigrated_changes) {
      if (expect_unmigrated_changes)
        throw new Error(
          'Schema is back up to date, please set expect_unmigrated_changes back to false'
        );
      throw new Error(
        `Schema is out of date! Run 'pnpm drizzle generate' to fix.\n` +
          `WARNING: note that IF you're DELETING esp. columns, ` +
          `then you may need to deploy the code with a schema that is lacking those columns but NOT yet migrated.\n` +
          `If you deploy a code with a column deletion in both migration and schema, the in-prod code that does effectively "select * ..." will cause drizzle's POJO mapper to crash complaining about a missing column. ` +
          `In this case, you must set const expect_unmigrated_changes = true; above. Please do generate the migration soon, however, so that other devs don't run into tricky semantic merge conflicts when they generate migrations. ` +
          `\n\nPending changes:\n${migrationStatements.join('\n')}`
      );
    }
  });

  /**
   * This test ensures that if someone adds/removes values from enums used in schema check constraints,
   * they are reminded to generate a migration. The check constraints in the database must match the
   * enum values in the code.
   *
   * If this test fails:
   * 1. Run 'pnpm drizzle generate' to create a migration for the check constraint changes
   * 2. Update the snapshot below with the new enum values
   */
  it('should have stable enum values for schema check constraints (run pnpm drizzle generate if you changed an enum)', () => {
    // Snapshot of expected enum values - update this when intentionally changing enums
    // After updating, run 'pnpm drizzle generate' to create the migration
    const expectedEnumValues = {
      KiloPassTier: ['tier_19', 'tier_49', 'tier_199'],
      KiloPassCadence: ['monthly', 'yearly'],
      KiloPassPaymentProvider: ['stripe', 'app_store', 'google_play'],
      KiloPassIssuanceSource: [
        'stripe_invoice',
        'app_store_transaction',
        'google_play_transaction',
        'cron',
      ],
      KiloPassIssuanceItemKind: ['base', 'bonus', 'promo_first_month_50pct', 'referral_bonus'],
      KiloPassWelcomePromoPaymentFingerprintType: [
        'card',
        'sepa_debit',
        'us_bank_account',
        'bacs_debit',
        'au_becs_debit',
      ],
      KiloPassWelcomePromoEligibilityReason: [
        'first_payment_fingerprint_claim',
        'fingerprint_previously_claimed',
        'missing_fingerprint',
        'no_supported_fingerprint',
        'no_positive_settlement',
        'settlement_unresolved',
      ],
      KiloPassAuditLogAction: [
        'stripe_webhook_received',
        'kilo_pass_invoice_paid_handled',
        'store_purchase_completed',
        'store_notification_received',
        'store_subscription_renewed',
        'store_subscription_canceled',
        'store_subscription_expired',
        'store_subscription_refunded',
        'base_credits_issued',
        'bonus_credits_issued',
        'bonus_credits_skipped_idempotent',
        'first_month_50pct_promo_issued',
        'yearly_monthly_base_cron_started',
        'yearly_monthly_base_cron_completed',
        'issue_yearly_remaining_credits',
        'duplicate_card_subscription_canceled',
        'yearly_monthly_bonus_cron_started',
        'yearly_monthly_bonus_cron_completed',
      ],
      KiloPassAuditLogResult: ['success', 'skipped_idempotent', 'failed'],
      KiloPassScheduledChangeStatus: ['not_started', 'active', 'completed', 'released', 'canceled'],
      CliSessionSharedState: ['public', 'organization'],
      SecurityAuditLogAction: [
        'security.finding.created',
        'security.finding.status_change',
        'security.finding.dismissed',
        'security.finding.auto_dismissed',
        'security.finding.analysis_started',
        'security.finding.analysis_completed',
        'security.finding.deleted',
        'security.config.enabled',
        'security.config.disabled',
        'security.config.updated',
        'security.sync.triggered',
        'security.sync.completed',
        'security.audit_log.exported',
      ],
      KiloClawPlan: ['trial', 'commit', 'standard'],
      KiloClawScheduledPlan: ['commit', 'standard'],
      KiloClawScheduledBy: ['auto', 'user'],
      KiloClawSubscriptionStatus: ['trialing', 'active', 'past_due', 'canceled', 'unpaid'],
      KiloClawSubscriptionAccessOrigin: ['earlybird'],
      KiloClawSubscriptionChangeActorType: ['user', 'system'],
      KiloClawSubscriptionChangeAction: [
        'created',
        'status_changed',
        'plan_switched',
        'period_advanced',
        'canceled',
        'reactivated',
        'suspended',
        'destruction_scheduled',
        'reassigned',
        'backfilled',
        'payment_source_changed',
        'schedule_changed',
        'admin_override',
      ],
      KiloClawTerminalRenewalFailureStatus: ['unresolved', 'resolved', 'waived', 'superseded'],
      KiloClawTerminalRenewalFailureCode: [
        'credit_balance_read_failed',
        'renewal_transaction_failed',
        'auto_top_up_marker_write_failed',
        'worker_timeout',
        'poison_payload',
        'queue_delivery_exhausted',
      ],
      KiloClawTerminalRenewalFailureResolutionActorType: ['operator', 'system'],
      StripeEarlyFraudWarningOwnerClassification: [
        'personal',
        'organization',
        'ambiguous',
        'unmatched',
      ],
      StripeEarlyFraudWarningCaseStatus: [
        'queued',
        'contained',
        'processing',
        'completed',
        'review_required',
        'failed',
        'remediated',
        'dismissed',
      ],
      StripeEarlyFraudWarningActionType: [
        'containment',
        'refund',
        'payment_value_clawback',
        'subscription_termination',
        'access_termination',
        'kiloclaw_suspension',
        'affiliate_payout_reversal',
        'referral_reward_reversal',
        'user_notice',
      ],
      StripeEarlyFraudWarningActionStatus: [
        'queued',
        'processing',
        'completed',
        'failed',
        'review_required',
        'dismissed',
      ],
      AffiliateProvider: ['impact'],
      AffiliateEventType: ['signup', 'trial_start', 'trial_end', 'sale', 'sale_reversal'],
      AffiliateEventDeliveryState: ['queued', 'blocked', 'sending', 'delivered', 'failed'],
      ImpactReferralProduct: ['kiloclaw', 'kilo_pass'],
      ImpactAdvocateProgramKey: ['kiloclaw', 'kilo_pass'],
      ImpactAttributionTouchType: ['affiliate', 'referral'],
      ImpactAttributionTouchProvider: ['impact_advocate', 'impact_performance'],
      ImpactAdvocateRegistrationState: ['pending', 'retrying', 'registered', 'failed'],
      ImpactAdvocateAttemptDeliveryState: ['queued', 'sending', 'succeeded', 'failed'],
      ImpactReferralBeneficiaryRole: ['referrer', 'referee'],
      ImpactReferralWinningTouchType: ['referral', 'affiliate', 'none'],
      ImpactReferralDecisionOutcome: ['granted', 'cap_limited', 'disqualified'],
      ImpactReferralRewardStatus: [
        'pending',
        'earned',
        'applied',
        'reversed',
        'expired',
        'canceled',
        'review_required',
      ],
      ImpactReferralRewardKind: ['kiloclaw_free_month', 'kilo_pass_bonus'],
      ImpactReferralPaymentProvider: ['stripe', 'credits', 'app_store', 'google_play'],
      ImpactConversionReportState: ['queued', 'retrying', 'delivered', 'failed'],
      ImpactAdvocateRewardRedemptionState: ['queued', 'retrying', 'redeemed', 'failed'],
    };

    const actualEnumValues: Record<string, string[]> = {};
    for (const [name, enumObj] of Object.entries(SCHEMA_CHECK_ENUMS)) {
      actualEnumValues[name] = (Object.values(enumObj) as string[]).sort();
    }

    // Sort expected values for comparison
    const sortedExpected: Record<string, string[]> = {};
    for (const [name, values] of Object.entries(expectedEnumValues)) {
      sortedExpected[name] = [...values].sort();
    }

    // Check for missing or extra enums in the registry
    const expectedEnumNames = Object.keys(expectedEnumValues).sort();
    const actualEnumNames = Object.keys(actualEnumValues).sort();

    if (JSON.stringify(expectedEnumNames) !== JSON.stringify(actualEnumNames)) {
      const missing = expectedEnumNames.filter(n => !actualEnumNames.includes(n));
      const extra = actualEnumNames.filter(n => !expectedEnumNames.includes(n));
      throw new Error(
        `SCHEMA_CHECK_ENUMS registry mismatch!\n` +
          (missing.length ? `Missing enums: ${missing.join(', ')}\n` : '') +
          (extra.length ? `Extra enums: ${extra.join(', ')}\n` : '') +
          `Update the expectedEnumValues snapshot in this test.`
      );
    }

    // Check each enum's values
    for (const [name, expectedValues] of Object.entries(sortedExpected)) {
      const actualValues = actualEnumValues[name];

      if (JSON.stringify(expectedValues) !== JSON.stringify(actualValues)) {
        const missing = expectedValues.filter(v => !actualValues.includes(v));
        const added = actualValues.filter(v => !expectedValues.includes(v));

        throw new Error(
          `Enum ${name} values have changed!\n` +
            (missing.length ? `Removed values: ${missing.join(', ')}\n` : '') +
            (added.length ? `Added values: ${added.join(', ')}\n` : '') +
            `\nIf this change is intentional:\n` +
            `1. Run 'pnpm drizzle generate' to create a migration for the check constraint\n` +
            `2. Update the expectedEnumValues.${name} snapshot in packages/db/src/schema.test.ts`
        );
      }
    }
  });

  it('exposes provider-aware Kilo Pass store tables', () => {
    expect(Object.hasOwn(schema, 'kilo_pass_store_events')).toBe(true);
    expect(Object.hasOwn(schema, 'kilo_pass_store_purchases')).toBe(true);
  });

  describe('Kilo Pass subscription provider IDs', () => {
    it('rejects Stripe subscriptions with null provider IDs', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        await expectProviderIdsCheckViolation(
          insertKiloPassSubscription({
            userId,
            paymentProvider: KiloPassPaymentProvider.Stripe,
            providerSubscriptionId: null,
            stripeSubscriptionId: null,
          })
        );
      });
    });

    it('rejects Stripe subscriptions with mismatched provider and Stripe IDs', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        await expectProviderIdsCheckViolation(
          insertKiloPassSubscription({
            userId,
            paymentProvider: KiloPassPaymentProvider.Stripe,
            providerSubscriptionId: 'sub_provider',
            stripeSubscriptionId: 'sub_stripe',
          })
        );
      });
    });

    it('rejects store provider subscriptions with a Stripe ID', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        await expectProviderIdsCheckViolation(
          insertKiloPassSubscription({
            userId,
            paymentProvider: KiloPassPaymentProvider.AppStore,
            providerSubscriptionId: '2000000000000001',
            stripeSubscriptionId: 'sub_store_invalid',
          })
        );
      });
    });

    it('allows valid Stripe subscriptions with matching provider and Stripe IDs', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        await insertKiloPassSubscription({
          userId,
          paymentProvider: KiloPassPaymentProvider.Stripe,
          providerSubscriptionId: 'sub_valid_stripe',
          stripeSubscriptionId: 'sub_valid_stripe',
        });
      });
    });

    it('allows valid App Store subscriptions with provider ID and null Stripe ID', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        await insertKiloPassSubscription({
          userId,
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerSubscriptionId: '2000000000000002',
          stripeSubscriptionId: null,
        });
      });
    });
  });

  describe('Kilo Pass store purchases', () => {
    it('allows valid App Store purchases for their referenced subscription owner', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
        const subscriptionId = await insertKiloPassSubscription({
          userId,
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerSubscriptionId,
          stripeSubscriptionId: null,
        });

        await insertKiloPassStorePurchase({
          subscriptionId,
          userId,
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerSubscriptionId,
        });
      });
    });

    it('rejects store purchases whose user does not own the referenced subscription', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        const otherUserId = `schema-kilo-pass-${crypto.randomUUID()}`;
        await schemaTestDb.db.insert(schema.kilocode_users).values({
          id: otherUserId,
          google_user_email: `${otherUserId}@example.com`,
          google_user_name: 'Schema Test Other User',
          google_user_image_url: 'https://example.com/avatar.png',
          stripe_customer_id: `cus_${crypto.randomUUID()}`,
        });

        try {
          const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
          const subscriptionId = await insertKiloPassSubscription({
            userId,
            paymentProvider: KiloPassPaymentProvider.AppStore,
            providerSubscriptionId,
            stripeSubscriptionId: null,
          });

          await expectStorePurchaseConstraintViolation(
            insertKiloPassStorePurchase({
              subscriptionId,
              userId: otherUserId,
              paymentProvider: KiloPassPaymentProvider.AppStore,
              providerSubscriptionId,
            }),
            'FK_kilo_pass_store_purchases_subscription_owner_provider'
          );
        } finally {
          await schemaTestDb.db
            .delete(schema.kilocode_users)
            .where(eq(schema.kilocode_users.id, otherUserId));
        }
      });
    });

    it('rejects store purchases whose provider does not match the referenced subscription', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
        const subscriptionId = await insertKiloPassSubscription({
          userId,
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerSubscriptionId,
          stripeSubscriptionId: null,
        });

        await expectStorePurchaseConstraintViolation(
          insertKiloPassStorePurchase({
            subscriptionId,
            userId,
            paymentProvider: KiloPassPaymentProvider.GooglePlay,
            providerSubscriptionId,
          }),
          'FK_kilo_pass_store_purchases_subscription_owner_provider'
        );
      });
    });

    it('rejects store purchases whose provider subscription ID does not match the referenced subscription', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
        const subscriptionId = await insertKiloPassSubscription({
          userId,
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerSubscriptionId,
          stripeSubscriptionId: null,
        });

        await expectStorePurchaseConstraintViolation(
          insertKiloPassStorePurchase({
            subscriptionId,
            userId,
            paymentProvider: KiloPassPaymentProvider.AppStore,
            providerSubscriptionId: `orig-${crypto.randomUUID()}`,
          }),
          'FK_kilo_pass_store_purchases_subscription_owner_provider'
        );
      });
    });

    it('rejects Stripe store purchase rows', async () => {
      await withKiloPassTestUser(async ({ userId }) => {
        const providerSubscriptionId = `sub_${crypto.randomUUID()}`;
        const subscriptionId = await insertKiloPassSubscription({
          userId,
          paymentProvider: KiloPassPaymentProvider.Stripe,
          providerSubscriptionId,
          stripeSubscriptionId: providerSubscriptionId,
        });

        await expectStorePurchaseConstraintViolation(
          insertKiloPassStorePurchase({
            subscriptionId,
            userId,
            paymentProvider: KiloPassPaymentProvider.Stripe,
            providerSubscriptionId,
          }),
          'kilo_pass_store_purchases_store_provider_check'
        );
      });
    });
  });
});
