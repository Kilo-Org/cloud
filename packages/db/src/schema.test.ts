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

type EphemeralDeploymentInsert = typeof schema.deployments_ephemeral.$inferInsert;
type CodingPlanInventoryInsert = typeof schema.coding_plan_key_inventory.$inferInsert;
type CodingPlanSubscriptionInsert = typeof schema.coding_plan_subscriptions.$inferInsert;

async function withEphemeralTestUser(
  testFn: (params: { userId: string }) => Promise<void>
): Promise<void> {
  const userId = `schema-ephemeral-${crypto.randomUUID()}`;

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
    await schemaTestDb.db
      .delete(schema.deployments_ephemeral)
      .where(eq(schema.deployments_ephemeral.owned_by_user_id, userId));
    await schemaTestDb.db.delete(schema.kilocode_users).where(eq(schema.kilocode_users.id, userId));
  }
}

async function insertEphemeralDeployment(
  overrides: Partial<EphemeralDeploymentInsert> = {}
): Promise<typeof schema.deployments_ephemeral.$inferSelect> {
  const [deployment] = await schemaTestDb.db
    .insert(schema.deployments_ephemeral)
    .values({
      source_type: 'html',
      internal_worker_name: `qdpl-${crypto.randomUUID()}`,
      status: 'pending',
      next_cleanup_at: '2026-06-03T00:00:00.000Z',
      ...overrides,
    })
    .returning();

  if (!deployment) {
    throw new Error('Failed to insert ephemeral deployment');
  }

  return deployment;
}

async function expectEphemeralConstraintViolation(
  insertPromise: Promise<unknown>,
  constraint: string
): Promise<void> {
  await expect(insertPromise).rejects.toMatchObject({
    cause: {
      constraint,
    },
  });
}

async function withCodingPlanSchemaUser(
  testFn: (params: { userId: string }) => Promise<void>
): Promise<void> {
  const userId = `schema-coding-plan-${crypto.randomUUID()}`;

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
    await schemaTestDb.db
      .delete(schema.coding_plan_subscriptions)
      .where(eq(schema.coding_plan_subscriptions.user_id, userId));
    await schemaTestDb.db
      .delete(schema.coding_plan_key_inventory)
      .where(eq(schema.coding_plan_key_inventory.assigned_to_user_id, userId));
    await schemaTestDb.db.delete(schema.kilocode_users).where(eq(schema.kilocode_users.id, userId));
  }
}

async function insertCodingPlanInventoryKey(values: {
  userId: string;
  planId: string;
  providerId: string;
}): Promise<string> {
  const [inventoryKey] = await schemaTestDb.db
    .insert(schema.coding_plan_key_inventory)
    .values({
      plan_id: values.planId,
      provider_id: values.providerId,
      upstream_plan_id: `upstream-${crypto.randomUUID()}`,
      credential_fingerprint: `fingerprint-${crypto.randomUUID()}`,
      assigned_to_user_id: values.userId,
      status: 'assigned',
    } satisfies CodingPlanInventoryInsert)
    .returning({ id: schema.coding_plan_key_inventory.id });

  if (!inventoryKey) {
    throw new Error('Failed to insert Coding Plan inventory key');
  }

  return inventoryKey.id;
}

async function insertCodingPlanSubscription(values: {
  userId: string;
  planId: string;
  providerId: string;
  keyInventoryId: string;
  status?: CodingPlanSubscriptionInsert['status'];
}): Promise<void> {
  await schemaTestDb.db.insert(schema.coding_plan_subscriptions).values({
    user_id: values.userId,
    plan_id: values.planId,
    provider_id: values.providerId,
    key_inventory_id: values.keyInventoryId,
    status: values.status ?? 'active',
    cost_microdollars: 20_000_000,
    billing_period_days: 30,
    current_period_start: '2026-06-01T00:00:00.000Z',
    current_period_end: '2026-07-01T00:00:00.000Z',
    credit_renewal_at: '2026-07-01T00:00:00.000Z',
  } satisfies CodingPlanSubscriptionInsert);
}

type PlatformIntegrationInsert = typeof schema.platform_integrations.$inferInsert;
type PlatformAccessTokenCredentialInsert =
  typeof schema.platform_access_token_credentials.$inferInsert;

async function withPlatformAccessTokenTestData(
  testFn: (params: {
    userId: string;
    organizationId: string;
    otherOrganizationId: string;
  }) => Promise<void>
): Promise<void> {
  const userId = `schema-platform-token-${crypto.randomUUID()}`;

  await schemaTestDb.db.insert(schema.kilocode_users).values({
    id: userId,
    google_user_email: `${userId}@example.com`,
    google_user_name: 'Schema Platform Token User',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${crypto.randomUUID()}`,
  });

  const organizationRows = await schemaTestDb.db
    .insert(schema.organizations)
    .values([
      { name: `Schema Platform Token Org ${crypto.randomUUID()}` },
      { name: `Schema Platform Token Other Org ${crypto.randomUUID()}` },
    ])
    .returning({ id: schema.organizations.id });
  const organization = organizationRows[0];
  const otherOrganization = organizationRows[1];
  if (!organization || !otherOrganization) {
    throw new Error('Failed to insert platform access token test organizations');
  }

  try {
    await testFn({
      userId,
      organizationId: organization.id,
      otherOrganizationId: otherOrganization.id,
    });
  } finally {
    await schemaTestDb.db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, organization.id));
    await schemaTestDb.db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, otherOrganization.id));
    await schemaTestDb.db.delete(schema.kilocode_users).where(eq(schema.kilocode_users.id, userId));
  }
}

async function insertPlatformIntegration(
  organizationId: string,
  overrides: Partial<PlatformIntegrationInsert> = {}
): Promise<typeof schema.platform_integrations.$inferSelect> {
  const [integration] = await schemaTestDb.db
    .insert(schema.platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      platform: 'bitbucket',
      integration_type: 'workspace_access_token',
      integration_status: 'active',
      ...overrides,
    })
    .returning();

  if (!integration) {
    throw new Error('Failed to insert platform integration');
  }

  return integration;
}

async function insertPlatformAccessTokenCredential(
  integration: typeof schema.platform_integrations.$inferSelect,
  overrides: Partial<PlatformAccessTokenCredentialInsert> = {}
): Promise<typeof schema.platform_access_token_credentials.$inferSelect> {
  const now = '2026-06-24T10:00:00.000Z';
  const [credential] = await schemaTestDb.db
    .insert(schema.platform_access_token_credentials)
    .values({
      platform_integration_id: integration.id,
      owned_by_organization_id: integration.owned_by_organization_id ?? crypto.randomUUID(),
      platform: 'bitbucket',
      integration_type: 'workspace_access_token',
      token_encrypted: 'encrypted-workspace-access-token',
      provider_credential_type: 'workspace_access_token',
      provider_scopes: ['account', 'repository', 'repository:write'],
      provider_verified_at: now,
      last_validated_at: now,
      ...overrides,
    })
    .returning();

  if (!credential) {
    throw new Error('Failed to insert platform access token credential');
  }

  return credential;
}

async function expectPlatformCredentialConstraintViolation(
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
        'security.finding.severity_changed',
        'security.finding.status_change',
        'security.finding.dismissed',
        'security.finding.auto_dismissed',
        'security.finding.superseded',
        'security.finding.analysis_started',
        'security.finding.analysis_completed',
        'security.finding.analysis_failed',
        'security.remediation.queued',
        'security.remediation.started',
        'security.remediation.pr_opened',
        'security.remediation.failed',
        'security.remediation.blocked',
        'security.remediation.no_changes_needed',
        'security.remediation.cancelled',
        'security.remediation.retried',
        'security.finding.deleted',
        'security.config.enabled',
        'security.config.disabled',
        'security.config.updated',
        'security.sync.triggered',
        'security.sync.completed',
        'security.audit_log.exported',
        'security.audit_report.generated',
      ],
      SecurityAuditLogActorType: ['customer_user', 'kilo_admin', 'system'],
      SecurityFindingAuditSourceContext: [
        'security_sync',
        'web',
        'analysis_worker',
        'remediation_callback',
        'rollout_baseline',
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
      StripeDisputeOwnerClassification: ['personal', 'organization', 'ambiguous', 'unmatched'],
      StripeDisputeCaseStatus: [
        'needs_action',
        'processing',
        'accepted',
        'acceptance_failed',
        'enforcement_failed',
        'review_required',
        'closed',
      ],
      StripeDisputeActionType: [
        'stripe_acceptance',
        'user_block',
        'auto_top_up_disable',
        'credit_balance_reset',
        'subscription_cancellation',
        'access_termination',
        'kiloclaw_suspension',
      ],
      StripeDisputeActionStatus: ['queued', 'processing', 'completed', 'failed', 'skipped'],
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
      BYOKManagementSource: ['user', 'coding_plan'],
      CodingPlanCredentialStatus: [
        'available',
        'assigned',
        'revocation_pending',
        'revoked',
        'revocation_failed',
      ],
      CodingPlanSubscriptionStatus: ['active', 'past_due', 'canceled'],
      CodingPlanTermKind: ['activation', 'extension', 'renewal'],
      CostInsightSpendCategory: ['variable', 'scheduled'],
      CostInsightSpendSource: ['ai_gateway', 'kiloclaw', 'coding_plan', 'other'],
      CostInsightRollupDegradedReason: [
        'capture_bypass',
        'reconciliation_mismatch',
        'late_source_data',
      ],
      CostInsightEventType: [
        'config_changed',
        'anomaly_alert',
        'threshold_crossed',
        'alert_reviewed',
        'suggestion_created',
        'suggestion_dismissed',
        'disabled',
      ],
      CostInsightAlertKind: ['anomaly', 'threshold', 'threshold_7d', 'threshold_30d'],
      CostInsightSuggestionKind: ['coding_plan', 'kilo_pass'],
      CostInsightNotificationStatus: ['pending', 'sending', 'sent', 'failed', 'skipped'],
      CodeReviewAnalyticsCaptureStatus: ['captured', 'missing', 'invalid', 'omitted'],
      CodeReviewAnalyticsChangeType: [
        'bug_fix',
        'feature',
        'refactor',
        'maintenance',
        'dependency',
        'test',
        'documentation',
        'mixed',
        'other',
      ],
      CodeReviewAnalyticsImpactLevel: ['low', 'medium', 'high'],
      CodeReviewAnalyticsComplexityLevel: ['low', 'medium', 'high'],
      CodeReviewAnalyticsClassificationConfidence: ['low', 'medium', 'high'],
      CodeReviewFindingSeverity: ['critical', 'warning', 'suggestion'],
      CodeReviewFindingCategory: [
        'security',
        'correctness',
        'reliability',
        'data_integrity',
        'performance',
        'compatibility',
        'maintainability',
        'test_quality',
        'documentation',
        'accessibility',
        'other',
      ],
      CodeReviewFindingSecurityClass: [
        'auth_access',
        'injection',
        'data_protection',
        'request_resource_boundary',
        'deserialization_object_integrity',
        'dependency_supply_chain',
        'memory_safety',
        'availability',
        'concurrency',
        'security_configuration',
        'other',
      ],
      MCPGatewayOwnerScope: ['personal', 'organization'],
      MCPGatewayAuthMode: ['none', 'static_headers', 'oauth_dynamic', 'oauth_static'],
      MCPGatewaySharingMode: ['single_user', 'multi_user'],
      MCPGatewayProviderScopeSource: ['none', 'discovered', 'override'],
      MCPGatewayRouteStatus: ['active', 'rotated', 'revoked'],
      MCPGatewayInstanceStatus: ['active', 'needs_reauth', 'revoked', 'removed'],
      MCPGatewayProviderGrantStatus: ['active', 'revoked'],
      MCPGatewaySecretKind: [
        'static_provider_credentials',
        'dynamic_registration',
        'static_headers',
      ],
      MCPGatewayOAuthClientAuthMethod: ['none', 'client_secret_post', 'client_secret_basic'],
      MCPGatewayAuthorizationRequestStatus: ['pending', 'completed', 'error'],
      MCPGatewayPendingProviderAuthorizationStatus: ['pending', 'completed', 'error'],
      MCPGatewayAuditOutcome: ['success', 'failure', 'blocked'],
      SecurityFindingNotificationKind: ['new_finding', 'sla_warning', 'sla_breach'],
      SecurityFindingNotificationStatus: [
        'staged',
        'pending',
        'sending',
        'sent',
        'failed',
        'cancelled',
      ],
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

  it('enforces one live Coding Plan subscription per user and provider', async () => {
    await withCodingPlanSchemaUser(async ({ userId }) => {
      const plusInventoryId = await insertCodingPlanInventoryKey({
        userId,
        planId: 'minimax-token-plan-plus',
        providerId: 'minimax',
      });
      const maxInventoryId = await insertCodingPlanInventoryKey({
        userId,
        planId: 'minimax-token-plan-max',
        providerId: 'minimax',
      });

      await insertCodingPlanSubscription({
        userId,
        planId: 'minimax-token-plan-plus',
        providerId: 'minimax',
        keyInventoryId: plusInventoryId,
      });

      await expect(
        insertCodingPlanSubscription({
          userId,
          planId: 'minimax-token-plan-max',
          providerId: 'minimax',
          keyInventoryId: maxInventoryId,
        })
      ).rejects.toMatchObject({
        cause: {
          constraint: 'UQ_coding_plan_sub_live_user_provider',
        },
      });
    });
  });

  it('exposes provider-neutral access token credentials', () => {
    expect(Object.hasOwn(schema, 'platform_access_token_credentials')).toBe(true);
  });

  describe('platform access token credentials', () => {
    it('stores one verified Bitbucket Workspace Access Token credential for an organization integration', async () => {
      await withPlatformAccessTokenTestData(async ({ organizationId }) => {
        const integration = await insertPlatformIntegration(organizationId);

        const credential = await insertPlatformAccessTokenCredential(integration);

        expect(credential).toEqual(
          expect.objectContaining({
            platform_integration_id: integration.id,
            owned_by_organization_id: organizationId,
            platform: 'bitbucket',
            integration_type: 'workspace_access_token',
            provider_credential_type: 'workspace_access_token',
            credential_version: 1,
          })
        );
        expect(credential).not.toHaveProperty('capability_profile');
      });
    });

    it('rejects a credential without a parent integration', async () => {
      await withPlatformAccessTokenTestData(async ({ organizationId }) => {
        const integration = await insertPlatformIntegration(organizationId);

        await expectPlatformCredentialConstraintViolation(
          insertPlatformAccessTokenCredential(integration, {
            platform_integration_id: crypto.randomUUID(),
          }),
          'FK_platform_access_token_credentials_parent'
        );
      });
    });

    it('rejects a second credential for the same integration', async () => {
      await withPlatformAccessTokenTestData(async ({ organizationId }) => {
        const integration = await insertPlatformIntegration(organizationId);
        await insertPlatformAccessTokenCredential(integration);

        await expectPlatformCredentialConstraintViolation(
          insertPlatformAccessTokenCredential(integration),
          'UQ_platform_access_token_credentials_platform_integration_id'
        );
      });
    });

    it('cascades credential deletion with its parent integration', async () => {
      await withPlatformAccessTokenTestData(async ({ organizationId }) => {
        const integration = await insertPlatformIntegration(organizationId);
        const credential = await insertPlatformAccessTokenCredential(integration);

        await schemaTestDb.db
          .delete(schema.platform_integrations)
          .where(eq(schema.platform_integrations.id, integration.id));

        expect(
          await schemaTestDb.db
            .select()
            .from(schema.platform_access_token_credentials)
            .where(eq(schema.platform_access_token_credentials.id, credential.id))
        ).toHaveLength(0);
      });
    });
  });

  describe('ephemeral deployments', () => {
    it('allows pending rows with null slug and expiry', async () => {
      await withEphemeralTestUser(async ({ userId }) => {
        const deployment = await insertEphemeralDeployment({ owned_by_user_id: userId });

        expect(deployment.deployment_slug).toBeNull();
        expect(deployment.expires_at).toBeNull();
      });
    });

    it.each([
      { deployment_slug: null, expires_at: '2026-06-04T00:00:00.000Z' },
      { deployment_slug: `schema-${crypto.randomUUID()}`, expires_at: null },
    ])('rejects active rows without both slug and expiry', async values => {
      await withEphemeralTestUser(async ({ userId }) => {
        await expectEphemeralConstraintViolation(
          insertEphemeralDeployment({ owned_by_user_id: userId, status: 'active', ...values }),
          'deployments_ephemeral_active_fields_check'
        );
      });
    });

    it('allows active rows with both slug and expiry', async () => {
      await withEphemeralTestUser(async ({ userId }) => {
        await insertEphemeralDeployment({
          owned_by_user_id: userId,
          status: 'active',
          deployment_slug: `schema-${crypto.randomUUID()}`,
          expires_at: '2026-06-04T00:00:00.000Z',
        });
      });
    });

    it.each([
      { cleanup_claim_token: crypto.randomUUID(), cleanup_claimed_until: null },
      { cleanup_claim_token: null, cleanup_claimed_until: '2026-06-03T00:01:00.000Z' },
    ])('rejects rows with only one claim field', async values => {
      await withEphemeralTestUser(async ({ userId }) => {
        await expectEphemeralConstraintViolation(
          insertEphemeralDeployment({ owned_by_user_id: userId, ...values }),
          'deployments_ephemeral_claim_fields_check'
        );
      });
    });

    it('allows rows with both claim fields present', async () => {
      await withEphemeralTestUser(async ({ userId }) => {
        await insertEphemeralDeployment({
          owned_by_user_id: userId,
          cleanup_claim_token: crypto.randomUUID(),
          cleanup_claimed_until: '2026-06-03T00:01:00.000Z',
        });
      });
    });

    it('rejects unsupported source types', async () => {
      await withEphemeralTestUser(async ({ userId }) => {
        await expectEphemeralConstraintViolation(
          insertEphemeralDeployment({ owned_by_user_id: userId, source_type: 'git' as 'html' }),
          'deployments_ephemeral_source_type_check'
        );
      });
    });

    it('rejects unsupported statuses', async () => {
      await withEphemeralTestUser(async ({ userId }) => {
        await expectEphemeralConstraintViolation(
          insertEphemeralDeployment({ owned_by_user_id: userId, status: 'completed' as 'pending' }),
          'deployments_ephemeral_status_check'
        );
      });
    });

    it('rejects duplicate internal worker names', async () => {
      await withEphemeralTestUser(async ({ userId }) => {
        const internal_worker_name = `qdpl-${crypto.randomUUID()}`;
        await insertEphemeralDeployment({ owned_by_user_id: userId, internal_worker_name });

        await expectEphemeralConstraintViolation(
          insertEphemeralDeployment({ owned_by_user_id: userId, internal_worker_name }),
          'UQ_deployments_ephemeral_internal_worker_name'
        );
      });
    });

    it('rejects duplicate non-null slugs while allowing multiple null slugs', async () => {
      await withEphemeralTestUser(async ({ userId }) => {
        await insertEphemeralDeployment({ owned_by_user_id: userId });
        await insertEphemeralDeployment({ owned_by_user_id: userId });

        const deployment_slug = `schema-${crypto.randomUUID()}`;
        await insertEphemeralDeployment({ owned_by_user_id: userId, deployment_slug });

        await expectEphemeralConstraintViolation(
          insertEphemeralDeployment({ owned_by_user_id: userId, deployment_slug }),
          'UQ_deployments_ephemeral_deployment_slug'
        );
      });
    });
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
