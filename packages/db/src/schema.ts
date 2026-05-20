import {
  pgTable,
  pgView,
  bigint,
  index,
  uuid,
  date,
  boolean,
  text,
  timestamp,
  jsonb,
  unique,
  real,
  integer,
  uniqueIndex,
  foreignKey,
  smallint,
  check,
  primaryKey,
  decimal,
  serial,
  vector,
  type AnyPgColumn,
  bigserial,
} from 'drizzle-orm/pg-core';
import { isNotNull, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  KiloPassTier,
  KiloPassCadence,
  KiloPassPaymentProvider,
  KiloPassIssuanceSource,
  KiloPassIssuanceItemKind,
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassScheduledChangeStatus,
  FeedbackFor,
  FeedbackSource,
  CliSessionSharedState,
  SecurityAuditLogAction,
  KiloClawPlan,
  KiloClawScheduledPlan,
  KiloClawScheduledBy,
  KiloClawProvider,
  KiloClawSubscriptionStatus,
  KiloClawPaymentSource,
  KiloClawSubscriptionAccessOrigin,
  KiloClawSubscriptionChangeActorType,
  KiloClawSubscriptionChangeAction,
  KiloClawTerminalRenewalFailureStatus,
  KiloClawTerminalRenewalFailureCode,
  KiloClawTerminalRenewalFailureResolutionActorType,
  AffiliateProvider,
  AffiliateEventType,
  AffiliateEventDeliveryState,
  KiloClawAttributionTouchType,
  KiloClawAttributionTouchProvider,
  ImpactAdvocateRegistrationState,
  ImpactAdvocateAttemptDeliveryState,
  KiloClawReferralBeneficiaryRole,
  KiloClawReferralWinningTouchType,
  KiloClawReferralDecisionOutcome,
  KiloClawReferralRewardStatus,
  ImpactConversionReportState,
  ImpactAdvocateRewardRedemptionState,
} from './schema-types';
import type {
  CustomLlmDefinition,
  KiloClawAdminAuditAction,
  KiloClawScheduledActionStatus,
  KiloClawScheduledActionStageStatus,
  KiloClawScheduledActionTargetStatus,
  KiloClawScheduledActionNotificationStatus,
  KiloClawScheduledActionNotificationChannel,
  KiloClawScheduledActionNotificationKind,
} from './schema-types';
import { KILOCLAW_PRICE_VERSIONS, type KiloClawPriceVersion } from './kiloclaw-pricing-catalog';
import type {
  OrganizationModeConfig,
  OrganizationPlan,
  OrganizationRole,
  OrganizationSettings,
  AuditLogAction,
  EncryptedData,
  AuthProviderId,
  AbuseClassification,
  PlatformRepository,
  IntegrationPermissions,
  BuildStatus,
  Provider,
  CodeReviewAgentConfig,
  DependabotAlertRaw,
  SecurityFindingAnalysis,
  NormalizedOpenRouterResponse,
  OpenRouterModel,
  StripeSubscriptionStatus,
  StoredModel,
  GatewayApiKind,
  ContributorChampionTier,
} from './schema-types';
import type { AnyPgColumn as DrizzleAnyPgColumn } from 'drizzle-orm/pg-core';
import { INSTANCE_TYPE_VALUES } from '@kilocode/kiloclaw-instance-tiers';

/**
 * Generates a complete check constraint for an enum column.
 * This ensures the column value is one of the enum values.
 *
 * IMPORTANT: If you add/remove values from any enum used here, you MUST generate a migration.
 * See src/db/schema.test.ts for the test that enforces this.
 *
 * @param name - The name of the check constraint
 * @param column - The column to check
 * @param enumObj - The enum object containing the allowed values
 * @returns Complete check constraint ready to use in table definition
 */
export function enumCheck<T extends Record<string, string>>(
  name: string,
  column: DrizzleAnyPgColumn,
  enumObj: T
) {
  return check(
    name,
    sql`${column} IN (${sql.join(
      Object.values(enumObj).map(v => sql.raw(`'${v}'`)),
      sql.raw(', ')
    )})`
  );
}

export const SCHEMA_CHECK_ENUMS = {
  KiloPassTier,
  KiloPassCadence,
  KiloPassPaymentProvider,
  KiloPassIssuanceSource,
  KiloPassIssuanceItemKind,
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassScheduledChangeStatus,
  CliSessionSharedState,
  SecurityAuditLogAction,
  KiloClawPlan,
  KiloClawScheduledPlan,
  KiloClawScheduledBy,
  KiloClawSubscriptionStatus,
  KiloClawSubscriptionAccessOrigin,
  KiloClawSubscriptionChangeActorType,
  KiloClawSubscriptionChangeAction,
  KiloClawTerminalRenewalFailureStatus,
  KiloClawTerminalRenewalFailureCode,
  KiloClawTerminalRenewalFailureResolutionActorType,
  AffiliateProvider,
  AffiliateEventType,
  AffiliateEventDeliveryState,
  KiloClawAttributionTouchType,
  KiloClawAttributionTouchProvider,
  ImpactAdvocateRegistrationState,
  ImpactAdvocateAttemptDeliveryState,
  KiloClawReferralBeneficiaryRole,
  KiloClawReferralWinningTouchType,
  KiloClawReferralDecisionOutcome,
  KiloClawReferralRewardStatus,
  ImpactConversionReportState,
  ImpactAdvocateRewardRedemptionState,
} as const;

export type AffiliateEventPayloadJson = {
  trackingId: string | null;
  customerId: string | null;
  customerEmailHash: string | null;
  orderId: string;
  eventDate: string;
  amount?: number | null;
  currencyCode?: string | null;
  itemCategory?: string | null;
  itemName?: string | null;
  itemSku?: string | null;
  promoCode?: string | null;
  stripeChargeId?: string | null;
  impactActionId?: string | null;
  impactSubmissionUri?: string | null;
  disputeId?: string | null;
};

export const credit_transactions = pgTable(
  'credit_transactions',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_user_id: text().notNull(),
    amount_microdollars: bigint({ mode: 'number' }).notNull(),
    expiration_baseline_microdollars_used: bigint({ mode: 'number' }),
    original_baseline_microdollars_used: bigint({ mode: 'number' }),
    is_free: boolean().notNull(),
    description: text(),
    original_transaction_id: uuid(), // Links expiration records to their original credit transaction
    stripe_payment_id: text(),
    coinbase_credit_block_id: text(),
    credit_category: text(),
    expiry_date: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    organization_id: uuid(),
    check_category_uniqueness: boolean().notNull().default(false),
  },
  table => [
    index('IDX_credit_transactions_created_at').on(table.created_at),
    index('IDX_credit_transactions_is_free').on(table.is_free),
    index('IDX_credit_transactions_kilo_user_id').on(table.kilo_user_id),
    index('IDX_credit_transactions_credit_category').on(table.credit_category),
    uniqueIndex('IDX_credit_transactions_stripe_payment_id').on(table.stripe_payment_id),
    uniqueIndex('IDX_credit_transactions_original_transaction_id').on(
      table.original_transaction_id
    ),
    uniqueIndex('IDX_credit_transactions_coinbase_credit_block_id').on(
      table.coinbase_credit_block_id
    ),
    index('IDX_credit_transactions_organization_id').on(table.organization_id),
    uniqueIndex('IDX_credit_transactions_unique_category')
      .on(table.kilo_user_id, table.credit_category)
      .where(sql`${table.check_category_uniqueness} = TRUE`),
  ]
);

export type CreditTransaction = typeof credit_transactions.$inferSelect;

export const credit_campaigns = pgTable(
  'credit_campaigns',
  {
    id: serial().primaryKey().notNull(),
    slug: text().notNull(),
    credit_category: text().notNull(),
    // Using integer (4-byte, max ~2.1B) rather than bigint because the
    // amount_usd is Zod-capped at $1000 = 1e9 microdollars, well under
    // int32. Keeps drizzle out of its bigint read path, which returns
    // native JS BigInt and chokes Next.js's RSC IO-tracing serializer.
    amount_microdollars: integer().notNull(),
    credit_expiry_hours: integer(),
    campaign_ends_at: timestamp({ withTimezone: true, mode: 'string' }),
    total_redemptions_allowed: integer().notNull(),
    active: boolean().notNull().default(true),
    description: text().notNull(),
    created_by_kilo_user_id: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('UQ_credit_campaigns_slug').on(table.slug),
    uniqueIndex('UQ_credit_campaigns_credit_category').on(table.credit_category),
    check('credit_campaigns_slug_format_check', sql`${table.slug} ~ '^[a-z0-9-]{5,40}$'`),
    check('credit_campaigns_amount_positive_check', sql`${table.amount_microdollars} > 0`),
    check(
      'credit_campaigns_credit_expiry_hours_positive_check',
      sql`${table.credit_expiry_hours} IS NULL OR ${table.credit_expiry_hours} > 0`
    ),
    check(
      'credit_campaigns_total_redemptions_allowed_positive_check',
      sql`${table.total_redemptions_allowed} > 0`
    ),
  ]
);

export type CreditCampaign = typeof credit_campaigns.$inferSelect;
export type NewCreditCampaign = typeof credit_campaigns.$inferInsert;

/**
 * When adding or removing PII/account-linked columns, update
 * softDeleteUser() in src/lib/user.ts (and src/lib/user.test.ts) to
 * null or reset the field.
 */
export const kilocode_users = pgTable(
  'kilocode_users',
  {
    id: text().primaryKey().notNull(),
    google_user_email: text().notNull(),
    google_user_name: text().notNull(),
    google_user_image_url: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    hosted_domain: text(),
    microdollars_used: bigint({ mode: 'number' })
      .default(sql`'0'`)
      .notNull(),
    /**
     * If set, bonus credits are issued on usage once `microdollars_used` crosses this threshold.
     * For Kilo Pass we currently treat it as "earned" slightly early (threshold - $1) when checking.
     */
    kilo_pass_threshold: bigint({ mode: 'number' }),
    stripe_customer_id: text().notNull(),
    app_store_account_token: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .notNull()
      .unique(),
    is_admin: boolean().default(false).notNull(),
    total_microdollars_acquired: bigint({ mode: 'number' })
      .default(sql`'0'`)
      .notNull(),
    next_credit_expiration_at: timestamp({
      withTimezone: true,
      mode: 'string',
    }),
    has_validation_stytch: boolean(),
    has_validation_novel_card_with_hold: boolean().default(false).notNull(),
    blocked_reason: text(),
    blocked_at: timestamp({ withTimezone: true, mode: 'string' }),
    blocked_by_kilo_user_id: text(),
    api_token_pepper: text(),
    web_session_pepper: text(),
    auto_top_up_enabled: boolean().default(false).notNull(),
    is_bot: boolean().default(false).notNull(),
    /**
     * When true, this user opts in to KiloClaw early access — their instances
     * will be offered the newest available image (including in-flight rollout
     * candidates) at provision and upgrade time, regardless of bucket. Used for
     * staff dogfooding and designated beta testers. Applies across all of the
     * user's instances (personal + every org instance they own). Pins still win.
     */
    kiloclaw_early_access: boolean().default(false).notNull(),

    /** @deprecated */
    default_model: text(),

    cohorts: jsonb().$type<Record<string, number>>().default({}).notNull(),
    completed_welcome_form: boolean().default(false).notNull(),
    linkedin_url: text(),
    github_url: text(),
    discord_server_membership_verified_at: timestamp({ withTimezone: true, mode: 'string' }),
    openrouter_upstream_safety_identifier: text(),
    vercel_downstream_safety_identifier: text(),
    customer_source: text(),
    signup_ip: text(),
    account_deletion_requested_at: timestamp({ withTimezone: true, mode: 'string' }),

    normalized_email: text(),
    email_domain: text(),
  },
  table => [
    unique('UQ_b1afacbcf43f2c7c4cb9f7e7faa').on(table.google_user_email),
    index('IDX_kilocode_users_signup_ip_created_at').on(table.signup_ip, table.created_at),
    index('IDX_kilocode_users_blocked_at').on(table.blocked_at),
    index('IDX_kilocode_users_blocked_by_kilo_user_id').on(table.blocked_by_kilo_user_id),
    // Prevent empty strings
    check('blocked_reason_not_empty', sql`length(blocked_reason) > 0`),
    uniqueIndex('UQ_kilocode_users_openrouter_upstream_safety_identifier')
      .on(table.openrouter_upstream_safety_identifier)
      .where(sql`${table.openrouter_upstream_safety_identifier} IS NOT NULL`),
    uniqueIndex('UQ_kilocode_users_vercel_downstream_safety_identifier')
      .on(table.vercel_downstream_safety_identifier)
      .where(sql`${table.vercel_downstream_safety_identifier} IS NOT NULL`),
    index('IDX_kilocode_users_normalized_email').on(table.normalized_email),
    index('IDX_kilocode_users_email_domain').on(table.email_domain),
  ]
);

export type User = typeof kilocode_users.$inferSelect;

export const user_affiliate_attributions = pgTable(
  'user_affiliate_attributions',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    provider: text().notNull().$type<AffiliateProvider>(),
    tracking_id: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_user_affiliate_attributions_user_provider').on(table.user_id, table.provider),
    index('IDX_user_affiliate_attributions_user_id').on(table.user_id),
    enumCheck('user_affiliate_attributions_provider_check', table.provider, AffiliateProvider),
  ]
);

export type UserAffiliateAttribution = typeof user_affiliate_attributions.$inferSelect;

export const user_affiliate_events = pgTable(
  'user_affiliate_events',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    provider: text().notNull().$type<AffiliateProvider>(),
    event_type: text().notNull().$type<AffiliateEventType>(),
    dedupe_key: text().notNull(),
    parent_event_id: uuid(),
    delivery_state: text()
      .notNull()
      .$type<AffiliateEventDeliveryState>()
      .default(AffiliateEventDeliveryState.Queued),
    payload_json: jsonb().$type<AffiliateEventPayloadJson>().notNull(),
    stripe_charge_id: text(),
    impact_action_id: text(),
    impact_submission_uri: text(),
    attempt_count: integer().notNull().default(0),
    next_retry_at: timestamp({ withTimezone: true, mode: 'string' }),
    claimed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    foreignKey({
      columns: [table.parent_event_id],
      foreignColumns: [table.id],
      name: 'user_affiliate_events_parent_event_id_fk',
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    unique('UQ_user_affiliate_events_dedupe_key').on(table.dedupe_key),
    index('IDX_user_affiliate_events_claim_path').on(
      table.delivery_state,
      sql`coalesce(${table.next_retry_at}, '-infinity'::timestamptz)`,
      table.created_at,
      table.id
    ),
    index('IDX_user_affiliate_events_parent_event_id').on(table.parent_event_id),
    index('IDX_user_affiliate_events_provider_event_type_charge').on(
      table.provider,
      table.event_type,
      table.stripe_charge_id
    ),
    enumCheck('user_affiliate_events_provider_check', table.provider, AffiliateProvider),
    enumCheck('user_affiliate_events_event_type_check', table.event_type, AffiliateEventType),
    enumCheck(
      'user_affiliate_events_delivery_state_check',
      table.delivery_state,
      AffiliateEventDeliveryState
    ),
    check(
      'user_affiliate_events_attempt_count_non_negative_check',
      sql`${table.attempt_count} >= 0`
    ),
  ]
);

export type UserAffiliateEvent = typeof user_affiliate_events.$inferSelect;

export const pending_impact_sale_reversals = pgTable(
  'pending_impact_sale_reversals',
  {
    stripe_charge_id: text().primaryKey().notNull(),
    dispute_id: text().notNull(),
    amount: real().notNull(),
    currency: text().notNull(),
    event_date: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    attempt_count: integer().notNull().default(0),
    last_attempt_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    check(
      'pending_impact_sale_reversals_attempt_count_non_negative_check',
      sql`${table.attempt_count} >= 0`
    ),
  ]
);

export type PendingImpactSaleReversal = typeof pending_impact_sale_reversals.$inferSelect;

export const deleted_user_email_tombstones = pgTable('deleted_user_email_tombstones', {
  normalized_email_hash: text().primaryKey().notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export type DeletedUserEmailTombstone = typeof deleted_user_email_tombstones.$inferSelect;

export const kiloclaw_attribution_touches = pgTable(
  'kiloclaw_attribution_touches',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    dedupe_key: text().notNull(),
    anonymous_id: text(),
    user_id: text().references(() => kilocode_users.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    touch_type: text().notNull().$type<KiloClawAttributionTouchType>(),
    provider: text().notNull().$type<KiloClawAttributionTouchProvider>(),
    opaque_tracking_value: text(),
    tracking_value_length: integer().notNull(),
    is_tracking_value_accepted: boolean().notNull().default(true),
    rs_code: text(),
    rs_share_medium: text(),
    rs_engagement_medium: text(),
    im_ref: text(),
    landing_path: text(),
    utm_source: text(),
    utm_medium: text(),
    utm_campaign: text(),
    utm_term: text(),
    utm_content: text(),
    touched_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    sale_attributed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_kiloclaw_attribution_touches_dedupe_key').on(table.dedupe_key),
    index('IDX_kiloclaw_attribution_touches_user_id').on(table.user_id),
    index('IDX_kiloclaw_attribution_touches_anonymous_id').on(table.anonymous_id),
    index('IDX_kiloclaw_attribution_touches_expires_at').on(table.expires_at),
    index('IDX_kiloclaw_attribution_touches_sale_attributed_at').on(table.sale_attributed_at),
    enumCheck(
      'kiloclaw_attribution_touches_touch_type_check',
      table.touch_type,
      KiloClawAttributionTouchType
    ),
    enumCheck(
      'kiloclaw_attribution_touches_provider_check',
      table.provider,
      KiloClawAttributionTouchProvider
    ),
    check(
      'kiloclaw_attribution_touches_tracking_value_length_non_negative_check',
      sql`${table.tracking_value_length} >= 0`
    ),
  ]
);

export type KiloClawAttributionTouch = typeof kiloclaw_attribution_touches.$inferSelect;

export const impact_advocate_participants = pgTable(
  'impact_advocate_participants',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    advocate_id: text().notNull(),
    advocate_account_id: text().notNull(),
    opaque_referral_identifier: text(),
    contact_email: text(),
    locale: text(),
    country_code: text(),
    registration_state: text()
      .notNull()
      .$type<ImpactAdvocateRegistrationState>()
      .default(ImpactAdvocateRegistrationState.Pending),
    registered_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_registration_attempt_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_error_code: text(),
    last_error_message: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_impact_advocate_participants_user_id').on(table.user_id),
    unique('UQ_impact_advocate_participants_opaque_referral_identifier').on(
      table.opaque_referral_identifier
    ),
    index('IDX_impact_advocate_participants_registration_state').on(table.registration_state),
    enumCheck(
      'impact_advocate_participants_registration_state_check',
      table.registration_state,
      ImpactAdvocateRegistrationState
    ),
  ]
);

export type ImpactAdvocateParticipant = typeof impact_advocate_participants.$inferSelect;

export const impact_advocate_registration_attempts = pgTable(
  'impact_advocate_registration_attempts',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    participant_id: uuid()
      .notNull()
      .references(() => impact_advocate_participants.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    dedupe_key: text().notNull(),
    opaque_cookie_value: text(),
    cookie_value_length: integer().notNull(),
    delivery_state: text()
      .notNull()
      .$type<ImpactAdvocateAttemptDeliveryState>()
      .default(ImpactAdvocateAttemptDeliveryState.Queued),
    request_payload: jsonb().$type<Record<string, unknown> | null>(),
    response_payload: jsonb().$type<Record<string, unknown> | null>(),
    response_status_code: integer(),
    attempt_count: integer().notNull().default(0),
    next_retry_at: timestamp({ withTimezone: true, mode: 'string' }),
    claimed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_impact_advocate_registration_attempts_dedupe_key').on(table.dedupe_key),
    index('IDX_impact_advocate_registration_attempts_participant_id').on(table.participant_id),
    index('IDX_impact_advocate_registration_attempts_delivery_state').on(table.delivery_state),
    enumCheck(
      'impact_advocate_registration_attempts_delivery_state_check',
      table.delivery_state,
      ImpactAdvocateAttemptDeliveryState
    ),
    check(
      'impact_advocate_registration_attempts_cookie_value_length_non_negative_check',
      sql`${table.cookie_value_length} >= 0`
    ),
    check(
      'impact_advocate_registration_attempts_attempt_count_non_negative_check',
      sql`${table.attempt_count} >= 0`
    ),
  ]
);

export type ImpactAdvocateRegistrationAttempt =
  typeof impact_advocate_registration_attempts.$inferSelect;

export const kiloclaw_referrals = pgTable(
  'kiloclaw_referrals',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    referee_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    referrer_user_id: text().references(() => kilocode_users.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    source_touch_id: uuid().references(() => kiloclaw_attribution_touches.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    impact_referral_id: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_kiloclaw_referrals_referee_user_id').on(table.referee_user_id),
    index('IDX_kiloclaw_referrals_referrer_user_id').on(table.referrer_user_id),
    index('IDX_kiloclaw_referrals_source_touch_id').on(table.source_touch_id),
  ]
);

export type KiloClawReferral = typeof kiloclaw_referrals.$inferSelect;

export const kiloclaw_referral_conversions = pgTable(
  'kiloclaw_referral_conversions',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    referee_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    referrer_user_id: text().references(() => kilocode_users.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    source_touch_id: uuid().references(() => kiloclaw_attribution_touches.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    winning_touch_type: text().notNull().$type<KiloClawReferralWinningTouchType>(),
    source_payment_id: text().notNull(),
    qualified: boolean().notNull().default(false),
    disqualification_reason: text(),
    converted_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_kiloclaw_referral_conversions_source_payment_id').on(table.source_payment_id),
    index('IDX_kiloclaw_referral_conversions_referee_user_id').on(table.referee_user_id),
    index('IDX_kiloclaw_referral_conversions_referrer_user_id').on(table.referrer_user_id),
    enumCheck(
      'kiloclaw_referral_conversions_winning_touch_type_check',
      table.winning_touch_type,
      KiloClawReferralWinningTouchType
    ),
  ]
);

export type KiloClawReferralConversion = typeof kiloclaw_referral_conversions.$inferSelect;

export const kiloclaw_referral_reward_decisions = pgTable(
  'kiloclaw_referral_reward_decisions',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    conversion_id: uuid()
      .notNull()
      .references(() => kiloclaw_referral_conversions.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    beneficiary_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    beneficiary_role: text().notNull().$type<KiloClawReferralBeneficiaryRole>(),
    outcome: text().notNull().$type<KiloClawReferralDecisionOutcome>(),
    reason: text(),
    months_granted: integer().notNull().default(0),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_kiloclaw_referral_reward_decisions_conversion_role').on(
      table.conversion_id,
      table.beneficiary_role
    ),
    index('IDX_kiloclaw_referral_reward_decisions_beneficiary_user_id').on(
      table.beneficiary_user_id
    ),
    enumCheck(
      'kiloclaw_referral_reward_decisions_beneficiary_role_check',
      table.beneficiary_role,
      KiloClawReferralBeneficiaryRole
    ),
    enumCheck(
      'kiloclaw_referral_reward_decisions_outcome_check',
      table.outcome,
      KiloClawReferralDecisionOutcome
    ),
    check(
      'kiloclaw_referral_reward_decisions_months_granted_non_negative_check',
      sql`${table.months_granted} >= 0`
    ),
  ]
);

export type KiloClawReferralRewardDecision = typeof kiloclaw_referral_reward_decisions.$inferSelect;

export const kiloclaw_referral_rewards = pgTable(
  'kiloclaw_referral_rewards',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    conversion_id: uuid()
      .notNull()
      .references(() => kiloclaw_referral_conversions.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    decision_id: uuid()
      .notNull()
      .references(() => kiloclaw_referral_reward_decisions.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    beneficiary_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    beneficiary_role: text().notNull().$type<KiloClawReferralBeneficiaryRole>(),
    months_granted: integer().notNull().default(1),
    status: text()
      .notNull()
      .$type<KiloClawReferralRewardStatus>()
      .default(KiloClawReferralRewardStatus.Pending),
    applies_to_subscription_id: uuid(),
    earned_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    applied_at: timestamp({ withTimezone: true, mode: 'string' }),
    reversed_at: timestamp({ withTimezone: true, mode: 'string' }),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }),
    review_reason: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_kiloclaw_referral_rewards_conversion_role').on(
      table.conversion_id,
      table.beneficiary_role
    ),
    unique('UQ_kiloclaw_referral_rewards_decision_id').on(table.decision_id),
    index('IDX_kiloclaw_referral_rewards_beneficiary_user_id').on(table.beneficiary_user_id),
    index('IDX_kiloclaw_referral_rewards_status').on(table.status),
    enumCheck(
      'kiloclaw_referral_rewards_beneficiary_role_check',
      table.beneficiary_role,
      KiloClawReferralBeneficiaryRole
    ),
    enumCheck('kiloclaw_referral_rewards_status_check', table.status, KiloClawReferralRewardStatus),
    check(
      'kiloclaw_referral_rewards_months_granted_positive_check',
      sql`${table.months_granted} > 0`
    ),
  ]
);

export type KiloClawReferralReward = typeof kiloclaw_referral_rewards.$inferSelect;

export const kiloclaw_referral_reward_applications = pgTable(
  'kiloclaw_referral_reward_applications',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    reward_id: uuid()
      .notNull()
      .references(() => kiloclaw_referral_rewards.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    beneficiary_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    subscription_id: uuid(),
    previous_renewal_boundary: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    new_renewal_boundary: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    local_operation_id: text(),
    stripe_operation_id: text(),
    stripe_idempotency_key: text(),
    applied_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_kiloclaw_referral_reward_applications_reward_id').on(table.reward_id),
    index('IDX_kiloclaw_referral_reward_applications_beneficiary_user_id').on(
      table.beneficiary_user_id
    ),
  ]
);

export type KiloClawReferralRewardApplication =
  typeof kiloclaw_referral_reward_applications.$inferSelect;

export const impact_advocate_reward_redemptions = pgTable(
  'impact_advocate_reward_redemptions',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    reward_id: uuid()
      .notNull()
      .references(() => kiloclaw_referral_rewards.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    dedupe_key: text().notNull(),
    beneficiary_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    state: text()
      .notNull()
      .$type<ImpactAdvocateRewardRedemptionState>()
      .default(ImpactAdvocateRewardRedemptionState.Queued),
    impact_reward_id: text(),
    request_payload: jsonb().$type<Record<string, unknown> | null>(),
    lookup_response_payload: jsonb().$type<Record<string, unknown> | null>(),
    redeem_response_payload: jsonb().$type<Record<string, unknown> | null>(),
    response_status_code: integer(),
    attempt_count: integer().notNull().default(0),
    next_retry_at: timestamp({ withTimezone: true, mode: 'string' }),
    redeemed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_impact_advocate_reward_redemptions_reward_id').on(table.reward_id),
    unique('UQ_impact_advocate_reward_redemptions_dedupe_key').on(table.dedupe_key),
    index('IDX_impact_advocate_reward_redemptions_beneficiary_user_id').on(
      table.beneficiary_user_id
    ),
    index('IDX_impact_advocate_reward_redemptions_state').on(table.state),
    enumCheck(
      'impact_advocate_reward_redemptions_state_check',
      table.state,
      ImpactAdvocateRewardRedemptionState
    ),
    check(
      'impact_advocate_reward_redemptions_attempt_count_non_negative_check',
      sql`${table.attempt_count} >= 0`
    ),
  ]
);

export type ImpactAdvocateRewardRedemption = typeof impact_advocate_reward_redemptions.$inferSelect;

export const impact_conversion_reports = pgTable(
  'impact_conversion_reports',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    conversion_id: uuid().references(() => kiloclaw_referral_conversions.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    dedupe_key: text().notNull(),
    action_tracker_id: integer().notNull(),
    order_id: text().notNull(),
    state: text()
      .notNull()
      .$type<ImpactConversionReportState>()
      .default(ImpactConversionReportState.Queued),
    request_payload: jsonb().$type<Record<string, unknown> | null>(),
    response_payload: jsonb().$type<Record<string, unknown> | null>(),
    response_status_code: integer(),
    attempt_count: integer().notNull().default(0),
    next_retry_at: timestamp({ withTimezone: true, mode: 'string' }),
    delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_impact_conversion_reports_dedupe_key').on(table.dedupe_key),
    index('IDX_impact_conversion_reports_conversion_id').on(table.conversion_id),
    index('IDX_impact_conversion_reports_state').on(table.state),
    enumCheck('impact_conversion_reports_state_check', table.state, ImpactConversionReportState),
    check(
      'impact_conversion_reports_attempt_count_non_negative_check',
      sql`${table.attempt_count} >= 0`
    ),
  ]
);

export type ImpactConversionReport = typeof impact_conversion_reports.$inferSelect;

export const kilo_pass_subscriptions = pgTable(
  'kilo_pass_subscriptions',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    payment_provider: text()
      .notNull()
      .$type<KiloPassPaymentProvider>()
      .default(KiloPassPaymentProvider.Stripe),
    provider_subscription_id: text(),
    stripe_subscription_id: text().unique(),
    tier: text().notNull().$type<KiloPassTier>(),
    cadence: text().notNull().$type<KiloPassCadence>(),
    status: text().notNull().$type<StripeSubscriptionStatus>(),
    /**
     * Tracks whether the subscription is set to cancel at the end of the current billing period.
     * When true with status='active', the subscription is effectively "pending cancellation".
     */
    cancel_at_period_end: boolean().notNull().default(false),
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    ended_at: timestamp({ withTimezone: true, mode: 'string' }),
    current_streak_months: integer().notNull().default(0),
    /**
     * Used to track the next eligible monthly bonus period for yearly Kilo Pass subscriptions.
     *
     * Bonus credits are now issued on usage (when a user crosses `kilocode_users.kilo_pass_threshold`),
     * but we still need a per-subscription month boundary for yearly cadence.
     */
    next_yearly_issue_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_kilo_pass_subscriptions_kilo_user_id').on(table.kilo_user_id),
    index('IDX_kilo_pass_subscriptions_payment_provider').on(table.payment_provider),
    index('IDX_kilo_pass_subscriptions_status').on(table.status),
    index('IDX_kilo_pass_subscriptions_cadence').on(table.cadence),
    uniqueIndex('UQ_kilo_pass_subscriptions_provider_subscription')
      .on(table.payment_provider, table.provider_subscription_id)
      .where(sql`${table.provider_subscription_id} IS NOT NULL`),
    uniqueIndex('UQ_kilo_pass_subscriptions_store_purchase_reference').on(
      table.id,
      table.kilo_user_id,
      table.payment_provider,
      table.provider_subscription_id
    ),
    check(
      'kilo_pass_subscriptions_current_streak_months_non_negative_check',
      sql`${table.current_streak_months} >= 0`
    ),
    check(
      'kilo_pass_subscriptions_provider_ids_check',
      sql`(
        ${table.payment_provider} = 'stripe'
        AND ${table.provider_subscription_id} IS NOT NULL
        AND ${table.stripe_subscription_id} IS NOT NULL
        AND ${table.provider_subscription_id} = ${table.stripe_subscription_id}
      ) OR (
        ${table.payment_provider} IN ('app_store', 'google_play')
        AND ${table.provider_subscription_id} IS NOT NULL
        AND ${table.stripe_subscription_id} IS NULL
      )`
    ),
    enumCheck(
      'kilo_pass_subscriptions_payment_provider_check',
      table.payment_provider,
      KiloPassPaymentProvider
    ),
    enumCheck('kilo_pass_subscriptions_tier_check', table.tier, KiloPassTier),
    enumCheck('kilo_pass_subscriptions_cadence_check', table.cadence, KiloPassCadence),
  ]
);

export type KiloPassSubscription = typeof kilo_pass_subscriptions.$inferSelect;
export type NewKiloPassSubscription = typeof kilo_pass_subscriptions.$inferInsert;

export const kilo_pass_store_events = pgTable(
  'kilo_pass_store_events',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    payment_provider: text().notNull().$type<KiloPassPaymentProvider>(),
    event_id: text().notNull(),
    provider_subscription_id: text(),
    provider_transaction_id: text(),
    app_account_token: uuid(),
    product_id: text().notNull(),
    environment: text().notNull(),
    payload_json: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    processing_started_at: timestamp({ withTimezone: true, mode: 'string' }),
    processed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('UQ_kilo_pass_store_events_provider_event').on(
      table.payment_provider,
      table.event_id
    ),
    index('IDX_kilo_pass_store_events_provider_subscription').on(
      table.payment_provider,
      table.provider_subscription_id
    ),
    index('IDX_kilo_pass_store_events_app_account_token').on(table.app_account_token),
    enumCheck(
      'kilo_pass_store_events_payment_provider_check',
      table.payment_provider,
      KiloPassPaymentProvider
    ),
  ]
);

export type KiloPassStoreEvent = typeof kilo_pass_store_events.$inferSelect;
export type NewKiloPassStoreEvent = typeof kilo_pass_store_events.$inferInsert;

export const kilo_pass_store_purchases = pgTable(
  'kilo_pass_store_purchases',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_pass_subscription_id: uuid()
      .notNull()
      .references(() => kilo_pass_subscriptions.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    payment_provider: text().notNull().$type<KiloPassPaymentProvider>(),
    product_id: text().notNull(),
    provider_subscription_id: text().notNull(),
    provider_transaction_id: text().notNull(),
    provider_original_transaction_id: text(),
    app_account_token: uuid(),
    purchase_token: text(),
    environment: text().notNull(),
    purchased_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }),
    raw_payload_json: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_kilo_pass_store_purchases_provider_transaction').on(
      table.payment_provider,
      table.provider_transaction_id
    ),
    index('IDX_kilo_pass_store_purchases_subscription_id').on(table.kilo_pass_subscription_id),
    index('IDX_kilo_pass_store_purchases_user_id').on(table.kilo_user_id),
    index('IDX_kilo_pass_store_purchases_app_account_token').on(table.app_account_token),
    index('IDX_kilo_pass_store_purchases_latest_subscription_purchase').on(
      table.payment_provider,
      table.provider_subscription_id,
      table.purchased_at.desc()
    ),
    foreignKey({
      columns: [
        table.kilo_pass_subscription_id,
        table.kilo_user_id,
        table.payment_provider,
        table.provider_subscription_id,
      ],
      foreignColumns: [
        kilo_pass_subscriptions.id,
        kilo_pass_subscriptions.kilo_user_id,
        kilo_pass_subscriptions.payment_provider,
        kilo_pass_subscriptions.provider_subscription_id,
      ],
      name: 'FK_kilo_pass_store_purchases_subscription_owner_provider',
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    check(
      'kilo_pass_store_purchases_store_provider_check',
      sql`${table.payment_provider} IN ('app_store', 'google_play')`
    ),
    enumCheck(
      'kilo_pass_store_purchases_payment_provider_check',
      table.payment_provider,
      KiloPassPaymentProvider
    ),
  ]
);

export type KiloPassStorePurchase = typeof kilo_pass_store_purchases.$inferSelect;
export type NewKiloPassStorePurchase = typeof kilo_pass_store_purchases.$inferInsert;

export const kilo_pass_issuances = pgTable(
  'kilo_pass_issuances',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_pass_subscription_id: uuid()
      .notNull()
      .references(() => kilo_pass_subscriptions.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    issue_month: date().notNull(),
    source: text().notNull().$type<KiloPassIssuanceSource>(),
    stripe_invoice_id: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_kilo_pass_issuances_subscription_issue_month').on(
      table.kilo_pass_subscription_id,
      table.issue_month
    ),
    uniqueIndex('UQ_kilo_pass_issuances_stripe_invoice_id')
      .on(table.stripe_invoice_id)
      .where(sql`${table.stripe_invoice_id} IS NOT NULL`),
    index('IDX_kilo_pass_issuances_subscription_id').on(table.kilo_pass_subscription_id),
    index('IDX_kilo_pass_issuances_issue_month').on(table.issue_month),
    check(
      'kilo_pass_issuances_issue_month_day_one_check',
      sql`EXTRACT(DAY FROM ${table.issue_month}) = 1`
    ),
    enumCheck('kilo_pass_issuances_source_check', table.source, KiloPassIssuanceSource),
  ]
);

export type KiloPassIssuance = typeof kilo_pass_issuances.$inferSelect;
export type NewKiloPassIssuance = typeof kilo_pass_issuances.$inferInsert;

export const kilo_pass_pause_events = pgTable(
  'kilo_pass_pause_events',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_pass_subscription_id: uuid()
      .notNull()
      .references(() => kilo_pass_subscriptions.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    paused_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    resumes_at: timestamp({ withTimezone: true, mode: 'string' }),
    resumed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_kilo_pass_pause_events_subscription_id').on(table.kilo_pass_subscription_id),
    uniqueIndex('UQ_kilo_pass_pause_events_one_open_per_sub')
      .on(table.kilo_pass_subscription_id)
      .where(sql`${table.resumed_at} IS NULL`),
    check(
      'kilo_pass_pause_events_resumed_at_after_paused_at_check',
      sql`${table.resumed_at} IS NULL OR ${table.resumed_at} >= ${table.paused_at}`
    ),
  ]
);

export type KiloPassPauseEvent = typeof kilo_pass_pause_events.$inferSelect;
export type NewKiloPassPauseEvent = typeof kilo_pass_pause_events.$inferInsert;

export const kilo_pass_issuance_items = pgTable(
  'kilo_pass_issuance_items',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_pass_issuance_id: uuid()
      .notNull()
      .references(() => kilo_pass_issuances.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    kind: text().notNull().$type<KiloPassIssuanceItemKind>(),
    credit_transaction_id: uuid()
      .notNull()
      .unique()
      .references(() => credit_transactions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    amount_usd: decimal({ precision: 12, scale: 2, mode: 'number' }).notNull(),
    bonus_percent_applied: decimal({ precision: 6, scale: 4, mode: 'number' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_kilo_pass_issuance_items_issuance_kind').on(table.kilo_pass_issuance_id, table.kind),
    index('IDX_kilo_pass_issuance_items_issuance_id').on(table.kilo_pass_issuance_id),
    index('IDX_kilo_pass_issuance_items_credit_transaction_id').on(table.credit_transaction_id),
    check(
      'kilo_pass_issuance_items_bonus_percent_applied_range_check',
      sql`${table.bonus_percent_applied} IS NULL OR (${table.bonus_percent_applied} >= 0 AND ${table.bonus_percent_applied} <= 1)`
    ),
    check('kilo_pass_issuance_items_amount_usd_non_negative_check', sql`${table.amount_usd} >= 0`),
    enumCheck('kilo_pass_issuance_items_kind_check', table.kind, KiloPassIssuanceItemKind),
  ]
);

export type KiloPassIssuanceItem = typeof kilo_pass_issuance_items.$inferSelect;
export type NewKiloPassIssuanceItem = typeof kilo_pass_issuance_items.$inferInsert;

export const kilo_pass_audit_log = pgTable(
  'kilo_pass_audit_log',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    kilo_user_id: text().references(() => kilocode_users.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    kilo_pass_subscription_id: uuid().references(() => kilo_pass_subscriptions.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    action: text().notNull().$type<KiloPassAuditLogAction>(),
    result: text().notNull().$type<KiloPassAuditLogResult>(),
    idempotency_key: text(),
    stripe_event_id: text(),
    stripe_invoice_id: text(),
    stripe_subscription_id: text(),
    related_credit_transaction_id: uuid().references(() => credit_transactions.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    related_monthly_issuance_id: uuid().references(() => kilo_pass_issuances.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    payload_json: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  table => [
    index('IDX_kilo_pass_audit_log_created_at').on(table.created_at),
    index('IDX_kilo_pass_audit_log_kilo_user_id').on(table.kilo_user_id),
    index('IDX_kilo_pass_audit_log_kilo_pass_subscription_id').on(table.kilo_pass_subscription_id),
    index('IDX_kilo_pass_audit_log_action').on(table.action),
    index('IDX_kilo_pass_audit_log_result').on(table.result),
    index('IDX_kilo_pass_audit_log_idempotency_key').on(table.idempotency_key),
    index('IDX_kilo_pass_audit_log_stripe_event_id').on(table.stripe_event_id),
    index('IDX_kilo_pass_audit_log_stripe_invoice_id').on(table.stripe_invoice_id),
    index('IDX_kilo_pass_audit_log_stripe_subscription_id').on(table.stripe_subscription_id),
    index('IDX_kilo_pass_audit_log_related_credit_transaction_id').on(
      table.related_credit_transaction_id
    ),
    index('IDX_kilo_pass_audit_log_related_monthly_issuance_id').on(
      table.related_monthly_issuance_id
    ),
    enumCheck('kilo_pass_audit_log_action_check', table.action, KiloPassAuditLogAction),
    enumCheck('kilo_pass_audit_log_result_check', table.result, KiloPassAuditLogResult),
  ]
);

export type KiloPassAuditLogEntry = typeof kilo_pass_audit_log.$inferSelect;
export type NewKiloPassAuditLogEntry = typeof kilo_pass_audit_log.$inferInsert;

export const kilo_pass_scheduled_changes = pgTable(
  'kilo_pass_scheduled_changes',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    stripe_subscription_id: text()
      .notNull()
      .references(() => kilo_pass_subscriptions.stripe_subscription_id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    from_tier: text().notNull().$type<KiloPassTier>(),
    from_cadence: text().notNull().$type<KiloPassCadence>(),
    to_tier: text().notNull().$type<KiloPassTier>(),
    to_cadence: text().notNull().$type<KiloPassCadence>(),
    stripe_schedule_id: text().notNull(),
    effective_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    status: text().notNull().$type<KiloPassScheduledChangeStatus>(),
    deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_kilo_pass_scheduled_changes_kilo_user_id').on(table.kilo_user_id),
    index('IDX_kilo_pass_scheduled_changes_status').on(table.status),
    index('IDX_kilo_pass_scheduled_changes_stripe_subscription_id').on(
      table.stripe_subscription_id
    ),
    // Only one active (non-deleted) scheduled change is allowed per subscription.
    // NOTE: This is a partial unique index; we keep historical rows after soft deletion.
    uniqueIndex('UQ_kilo_pass_scheduled_changes_active_stripe_subscription_id')
      .on(table.stripe_subscription_id)
      .where(isNull(table.deleted_at)),
    index('IDX_kilo_pass_scheduled_changes_effective_at').on(table.effective_at),
    index('IDX_kilo_pass_scheduled_changes_deleted_at').on(table.deleted_at),
    enumCheck('kilo_pass_scheduled_changes_from_tier_check', table.from_tier, KiloPassTier),
    enumCheck(
      'kilo_pass_scheduled_changes_from_cadence_check',
      table.from_cadence,
      KiloPassCadence
    ),
    enumCheck('kilo_pass_scheduled_changes_to_tier_check', table.to_tier, KiloPassTier),
    enumCheck('kilo_pass_scheduled_changes_to_cadence_check', table.to_cadence, KiloPassCadence),
    enumCheck(
      'kilo_pass_scheduled_changes_status_check',
      table.status,
      KiloPassScheduledChangeStatus
    ),
  ]
);

export type KiloPassScheduledChange = typeof kilo_pass_scheduled_changes.$inferSelect;
export type NewKiloPassScheduledChange = typeof kilo_pass_scheduled_changes.$inferInsert;

export const auto_top_up_configs = pgTable(
  'auto_top_up_configs',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    owned_by_user_id: text().references(() => kilocode_users.id, {
      onDelete: 'cascade',
      onUpdate: 'cascade',
    }),
    owned_by_organization_id: uuid().references(() => organizations.id, {
      onDelete: 'cascade',
      onUpdate: 'cascade',
    }),
    created_by_user_id: text(), // Audit trail: null for user-owned, set for org-owned
    stripe_payment_method_id: text().notNull(),
    amount_cents: integer().notNull().default(5000), // Default $50, options: 2000, 5000, 10000
    last_auto_top_up_at: timestamp({ withTimezone: true, mode: 'string' }),
    attempt_started_at: timestamp({ withTimezone: true, mode: 'string' }),
    disabled_reason: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_auto_top_up_configs_owned_by_user_id')
      .on(table.owned_by_user_id)
      .where(sql`${table.owned_by_user_id} IS NOT NULL`),
    uniqueIndex('UQ_auto_top_up_configs_owned_by_organization_id')
      .on(table.owned_by_organization_id)
      .where(sql`${table.owned_by_organization_id} IS NOT NULL`),
    check(
      'auto_top_up_configs_exactly_one_owner',
      sql`(${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)`
    ),
  ]
);

export type AutoTopUpConfig = typeof auto_top_up_configs.$inferSelect;

export const user_auth_provider = pgTable(
  'user_auth_provider',
  {
    kilo_user_id: text().notNull(),
    provider: text().notNull().$type<AuthProviderId>(),
    provider_account_id: text().notNull(),
    email: text().notNull(),
    avatar_url: text().notNull(),

    display_name: text(),
    hosted_domain: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    primaryKey({ columns: [table.provider, table.provider_account_id] }),
    index('IDX_user_auth_provider_kilo_user_id').on(table.kilo_user_id),
    index('IDX_user_auth_provider_hosted_domain').on(table.hosted_domain),
  ]
);

export type PaymentMethod = typeof payment_methods.$inferSelect;

export const payment_methods = pgTable(
  'payment_methods',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    stripe_fingerprint: text(),
    user_id: text().notNull(),
    stripe_id: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    last4: text(),
    brand: text(),
    address_line1: text(),
    address_line2: text(),
    address_city: text(),
    address_state: text(),
    address_zip: text(),
    address_country: text(),
    name: text(),
    three_d_secure_supported: boolean(),
    funding: text(),
    regulated_status: text(),
    address_line1_check_status: text(),
    postal_code_check_status: text(),
    http_x_forwarded_for: text(),
    http_x_vercel_ip_city: text(),
    http_x_vercel_ip_country: text(),
    http_x_vercel_ip_latitude: real(),
    http_x_vercel_ip_longitude: real(),
    http_x_vercel_ja4_digest: text(),
    eligible_for_free_credits: boolean().default(false).notNull(),
    deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
    stripe_data: jsonb(),
    type: text(),
    organization_id: uuid(),
  },
  table => [
    index('IDX_d7d7fb15569674aaadcfbc0428').on(table.user_id),
    index('IDX_e1feb919d0ab8a36381d5d5138').on(table.stripe_fingerprint),
    unique('UQ_29df1b0403df5792c96bbbfdbe6').on(table.user_id, table.stripe_id),
    index('IDX_payment_methods_organization_id').on(table.organization_id),
  ]
);
export type MicrodollarUsage = typeof microdollar_usage.$inferSelect;
export const microdollar_usage = pgTable(
  'microdollar_usage',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    kilo_user_id: text().notNull(),
    cost: bigint({ mode: 'number' }).notNull(),
    input_tokens: bigint({ mode: 'number' }).notNull(),
    output_tokens: bigint({ mode: 'number' }).notNull(),
    cache_write_tokens: bigint({ mode: 'number' }).notNull(),
    cache_hit_tokens: bigint({ mode: 'number' }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    provider: text(),
    model: text(),
    requested_model: text(),
    cache_discount: bigint({ mode: 'number' }),
    has_error: boolean().default(false).notNull(),
    // Abuse classification: positive = abuse, negative = not abuse, 0 = not yet classified
    abuse_classification: smallint().default(0).notNull().$type<AbuseClassification>(),
    organization_id: uuid(),
    inference_provider: text(),
    project_id: text(),
  },
  table => [
    index('idx_created_at').on(table.created_at),
    index('idx_abuse_classification').on(table.abuse_classification),
    index('idx_kilo_user_id_created_at2').on(table.kilo_user_id, table.created_at),
    index('idx_microdollar_usage_organization_id')
      .on(table.organization_id)
      .where(isNotNull(table.organization_id)),
  ]
);

// Per-day rollup of microdollar_usage.cost, keyed by (kilo_user_id, organization_id,
// usage_date). Maintained by the same CTE that inserts into microdollar_usage so it
// is updated atomically with the source row. Powers the hot 3-month-rolling-sum
// query in kiloPass.getAverageMonthlyUsageLast3Months without scanning the raw
// 800M-row microdollar_usage table.
export const microdollar_usage_daily = pgTable(
  'microdollar_usage_daily',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    kilo_user_id: text().notNull(),
    organization_id: uuid(),
    usage_date: date({ mode: 'string' }).notNull(),
    total_cost_microdollars: bigint({ mode: 'number' }).notNull().default(0),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Personal-scope rollup: one row per user per day (no org).
    uniqueIndex('idx_microdollar_usage_daily_personal')
      .on(table.kilo_user_id, table.usage_date)
      .where(isNull(table.organization_id)),
    // Org-scope rollup: one row per user per org per day.
    uniqueIndex('idx_microdollar_usage_daily_org')
      .on(table.kilo_user_id, table.organization_id, table.usage_date)
      .where(isNotNull(table.organization_id)),
  ]
);

export type MicrodollarUsageDaily = typeof microdollar_usage_daily.$inferSelect;

export const microdollar_usage_metadata = pgTable(
  'microdollar_usage_metadata',
  {
    id: uuid().notNull().primaryKey(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }),
    message_id: text().notNull(),
    http_user_agent_id: integer().references(() => http_user_agent.http_user_agent_id),
    http_ip_id: integer().references(() => http_ip.http_ip_id),
    vercel_ip_city_id: integer().references(() => vercel_ip_city.vercel_ip_city_id),
    vercel_ip_country_id: integer().references(() => vercel_ip_country.vercel_ip_country_id),
    vercel_ip_latitude: real(),
    vercel_ip_longitude: real(),
    ja4_digest_id: integer().references(() => ja4_digest.ja4_digest_id),
    user_prompt_prefix: text(),
    system_prompt_prefix_id: integer().references(
      () => system_prompt_prefix.system_prompt_prefix_id
    ),
    system_prompt_length: integer(),
    max_tokens: bigint({ mode: 'number' }),
    has_middle_out_transform: boolean(),
    status_code: smallint(),
    upstream_id: text(),
    finish_reason_id: integer(),
    latency: real(),
    moderation_latency: real(),
    generation_time: real(),
    is_byok: boolean(),
    is_user_byok: boolean(),
    streamed: boolean(),
    cancelled: boolean(),
    editor_name_id: integer(),
    api_kind_id: integer(),
    has_tools: boolean(),
    machine_id: text(),
    feature_id: integer(),
    session_id: text(),
    mode_id: integer(),
    auto_model_id: integer(),
    market_cost: bigint({ mode: 'number' }),
    is_free: boolean(),
  },
  table => [
    index('idx_microdollar_usage_metadata_created_at').on(table.created_at),
    index('idx_microdollar_usage_metadata_session_id_created_at')
      .on(table.session_id, table.created_at)
      .where(isNotNull(table.session_id)),
  ]
);

export const api_request_log = pgTable(
  'api_request_log',
  {
    id: bigserial({ mode: 'bigint' }).notNull().primaryKey(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    kilo_user_id: text(),
    organization_id: text(),
    provider: text(),
    model: text(),
    status_code: integer(),
    request: jsonb(),
    response: text(),
    error: jsonb(),
  },
  table => [index('idx_api_request_log_created_at').on(table.created_at)]
);

export const http_user_agent = pgTable(
  'http_user_agent',
  {
    http_user_agent_id: serial().notNull().primaryKey(),
    http_user_agent: text().notNull(),
  },
  table => [
    uniqueIndex('UQ_http_user_agent').on(table.http_user_agent), // TODO include columns in migration!
  ]
);

export const http_ip = pgTable(
  'http_ip',
  {
    http_ip_id: serial().notNull().primaryKey(),
    http_ip: text().notNull(),
  },
  table => [
    uniqueIndex('UQ_http_ip').on(table.http_ip), // TODO include columns in migration!
  ]
);

export const vercel_ip_country = pgTable(
  'vercel_ip_country',
  {
    vercel_ip_country_id: serial().notNull().primaryKey(),
    vercel_ip_country: text().notNull(),
  },
  table => [
    uniqueIndex('UQ_vercel_ip_country').on(table.vercel_ip_country), // TODO include columns in migration!
  ]
);
export const vercel_ip_city = pgTable(
  'vercel_ip_city',
  {
    vercel_ip_city_id: serial().notNull().primaryKey(),
    vercel_ip_city: text().notNull(),
  },
  table => [
    uniqueIndex('UQ_vercel_ip_city').on(table.vercel_ip_city), // TODO include columns in migration!
  ]
);
export const system_prompt_prefix = pgTable(
  'system_prompt_prefix',
  {
    system_prompt_prefix_id: serial().notNull().primaryKey(),
    system_prompt_prefix: text().notNull(),
  },
  table => [
    uniqueIndex('UQ_system_prompt_prefix').on(table.system_prompt_prefix), // TODO include columns in migration!
  ]
);

export const ja4_digest = pgTable(
  'ja4_digest',
  {
    ja4_digest_id: serial().notNull().primaryKey(),
    ja4_digest: text().notNull(),
  },
  table => [
    uniqueIndex('UQ_ja4_digest').on(table.ja4_digest), // TODO include columns in migration!
  ]
);

export const finish_reason = pgTable(
  'finish_reason',
  {
    finish_reason_id: serial().notNull().primaryKey(),
    finish_reason: text().notNull(),
  },
  table => [uniqueIndex('UQ_finish_reason').on(table.finish_reason)]
);

export const editor_name = pgTable(
  'editor_name',
  {
    editor_name_id: serial().notNull().primaryKey(),
    editor_name: text().notNull(),
  },
  table => [uniqueIndex('UQ_editor_name').on(table.editor_name)]
);

export const api_kind = pgTable(
  'api_kind',
  {
    api_kind_id: serial().notNull().primaryKey(),
    api_kind: text().notNull().$type<GatewayApiKind>(),
  },
  table => [uniqueIndex('UQ_api_kind').on(table.api_kind)]
);

export const feature = pgTable(
  'feature',
  {
    feature_id: serial().notNull().primaryKey(),
    feature: text().notNull(),
  },
  table => [uniqueIndex('UQ_feature').on(table.feature)]
);

export const mode = pgTable(
  'mode',
  {
    mode_id: serial().notNull().primaryKey(),
    mode: text().notNull(),
  },
  table => [uniqueIndex('UQ_mode').on(table.mode)]
);

export const auto_model = pgTable(
  'auto_model',
  {
    auto_model_id: serial().notNull().primaryKey(),
    auto_model: text().notNull(),
  },
  table => [uniqueIndex('UQ_auto_model').on(table.auto_model)]
);

export const microdollar_usage_view = pgView('microdollar_usage_view', {
  id: uuid().notNull(),
  kilo_user_id: text().notNull(),
  message_id: text(),
  cost: bigint({ mode: 'number' }).notNull(),
  input_tokens: bigint({ mode: 'number' }).notNull(),
  output_tokens: bigint({ mode: 'number' }).notNull(),
  cache_write_tokens: bigint({ mode: 'number' }).notNull(),
  cache_hit_tokens: bigint({ mode: 'number' }).notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  http_x_forwarded_for: text(),
  http_x_vercel_ip_city: text(),
  http_x_vercel_ip_country: text(),
  http_x_vercel_ip_latitude: real(),
  http_x_vercel_ip_longitude: real(),
  http_x_vercel_ja4_digest: text(),
  provider: text(),
  model: text(),
  requested_model: text(),
  user_prompt_prefix: text(),
  system_prompt_prefix: text(),
  system_prompt_length: integer(),
  http_user_agent: text(),
  cache_discount: bigint({ mode: 'number' }),
  max_tokens: bigint({ mode: 'number' }),
  has_middle_out_transform: boolean(),
  has_error: boolean().notNull(),
  abuse_classification: smallint().notNull().$type<AbuseClassification>(),
  organization_id: uuid(),
  inference_provider: text(),
  project_id: text(),
  status_code: smallint(),
  upstream_id: text(),
  finish_reason: text(),
  latency: real(),
  moderation_latency: real(),
  generation_time: real(),
  is_byok: boolean(),
  is_user_byok: boolean(),
  streamed: boolean(),
  cancelled: boolean(),
  editor_name: text(),
  api_kind: text().$type<GatewayApiKind>(),
  has_tools: boolean(),
  machine_id: text(),
  feature: text(),
  session_id: text(),
  mode: text(),
  auto_model: text(),
  market_cost: bigint({ mode: 'number' }),
  is_free: boolean(),
}).as(sql`
  SELECT
    mu.id,
    mu.kilo_user_id,
    meta.message_id,
    mu.cost,
    mu.input_tokens,
    mu.output_tokens,
    mu.cache_write_tokens,
    mu.cache_hit_tokens,
    mu.created_at,
    ip.http_ip AS http_x_forwarded_for,
    city.vercel_ip_city AS http_x_vercel_ip_city,
    country.vercel_ip_country AS http_x_vercel_ip_country,
    meta.vercel_ip_latitude AS http_x_vercel_ip_latitude,
    meta.vercel_ip_longitude AS http_x_vercel_ip_longitude,
    ja4.ja4_digest AS http_x_vercel_ja4_digest,
    mu.provider,
    mu.model,
    mu.requested_model,
    meta.user_prompt_prefix,
    spp.system_prompt_prefix,
    meta.system_prompt_length,
    ua.http_user_agent,
    mu.cache_discount,
    meta.max_tokens,
    meta.has_middle_out_transform,
    mu.has_error,
    mu.abuse_classification,
    mu.organization_id,
    mu.inference_provider,
    mu.project_id,
    meta.status_code,
    meta.upstream_id,
    frfr.finish_reason,
    meta.latency,
    meta.moderation_latency,
    meta.generation_time,
    meta.is_byok,
    meta.is_user_byok,
    meta.streamed,
    meta.cancelled,
    edit.editor_name,
    ak.api_kind,
    meta.has_tools,
    meta.machine_id,
    feat.feature,
    meta.session_id,
    md.mode,
    am.auto_model,
    meta.market_cost,
    meta.is_free
  FROM ${microdollar_usage} mu
  LEFT JOIN ${microdollar_usage_metadata} meta ON mu.id = meta.id
  LEFT JOIN ${http_ip} ip ON meta.http_ip_id = ip.http_ip_id
  LEFT JOIN ${vercel_ip_city} city ON meta.vercel_ip_city_id = city.vercel_ip_city_id
  LEFT JOIN ${vercel_ip_country} country ON meta.vercel_ip_country_id = country.vercel_ip_country_id
  LEFT JOIN ${ja4_digest} ja4 ON meta.ja4_digest_id = ja4.ja4_digest_id
  LEFT JOIN ${system_prompt_prefix} spp ON meta.system_prompt_prefix_id = spp.system_prompt_prefix_id
  LEFT JOIN ${http_user_agent} ua ON meta.http_user_agent_id = ua.http_user_agent_id
  LEFT JOIN ${finish_reason} frfr ON meta.finish_reason_id = frfr.finish_reason_id
  LEFT JOIN ${editor_name} edit ON meta.editor_name_id = edit.editor_name_id
  LEFT JOIN ${api_kind} ak ON meta.api_kind_id = ak.api_kind_id
  LEFT JOIN ${feature} feat ON meta.feature_id = feat.feature_id
  LEFT JOIN ${mode} md ON meta.mode_id = md.mode_id
  LEFT JOIN ${auto_model} am ON meta.auto_model_id = am.auto_model_id
`);

export type MicrodollarUsageView = typeof microdollar_usage_view.$inferSelect;

export const custom_llm2 = pgTable('custom_llm2', {
  public_id: text().notNull().primaryKey(),
  definition: jsonb().notNull().$type<CustomLlmDefinition>(),
});

export const user_admin_notes = pgTable(
  'user_admin_notes',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_user_id: text().notNull(),
    note_content: text().notNull(),
    admin_kilo_user_id: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_34517df0b385234babc38fe81b').on(table.admin_kilo_user_id),
    index('IDX_ccbde98c4c14046daa5682ec4f').on(table.kilo_user_id),
    index('IDX_d0270eb24ef6442d65a0b7853c').on(table.created_at),
  ]
);
export type UserAdminNote = typeof user_admin_notes.$inferSelect;

export const user_feedback = pgTable(
  'user_feedback',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_user_id: text().references(() => kilocode_users.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    feedback_text: text().notNull(),
    feedback_for: text().notNull().default(FeedbackFor.Unknown),
    feedback_batch: text(),
    source: text().notNull().default(FeedbackSource.Unknown),
    context_json: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_user_feedback_created_at').on(table.created_at),
    index('IDX_user_feedback_kilo_user_id').on(table.kilo_user_id),
    index('IDX_user_feedback_feedback_for').on(table.feedback_for),
    index('IDX_user_feedback_feedback_batch').on(table.feedback_batch),
    index('IDX_user_feedback_source').on(table.source),
  ]
);

export type UserFeedback = typeof user_feedback.$inferSelect;
export type NewUserFeedback = typeof user_feedback.$inferInsert;

export const stytch_fingerprints = pgTable(
  'stytch_fingerprints',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_user_id: text().notNull(),
    visitor_fingerprint: text().notNull(),
    browser_fingerprint: text().notNull(),
    browser_id: text(),
    hardware_fingerprint: text().notNull(),
    network_fingerprint: text().notNull(),
    visitor_id: text(),
    verdict_action: text().notNull(),
    detected_device_type: text().notNull(),
    is_authentic_device: boolean().notNull(),
    reasons: text().array().default(['']).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    status_code: integer().notNull(),
    fingerprint_data: jsonb().notNull(),
    kilo_free_tier_allowed: boolean().default(false).notNull(),
    http_x_forwarded_for: text(),
    http_x_vercel_ip_city: text(),
    http_x_vercel_ip_country: text(),
    http_x_vercel_ip_latitude: real(),
    http_x_vercel_ip_longitude: real(),
    http_x_vercel_ja4_digest: text(),
    http_user_agent: text(),
  },
  table => [
    index('idx_hardware_fingerprint').on(table.hardware_fingerprint),
    index('idx_kilo_user_id').on(table.kilo_user_id),
    index('idx_stytch_fingerprints_reasons_gin').using('gin', table.reasons),
    index('idx_verdict_action').on(table.verdict_action),
    index('idx_visitor_fingerprint').on(table.visitor_fingerprint),
  ]
);

export type StytchFingerprint = typeof stytch_fingerprints.$inferSelect;

export const referral_codes = pgTable(
  'referral_codes',
  {
    id: uuid()
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .notNull(),
    kilo_user_id: text().notNull(),
    code: text().notNull(),
    max_redemptions: integer().default(10).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_referral_codes_kilo_user_id').on(table.kilo_user_id),
    index('IDX_referral_codes_code').on(table.code),
  ]
);

export const referral_code_usages = pgTable(
  'referral_code_usages',
  {
    id: uuid()
      .primaryKey()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .notNull(),
    referring_kilo_user_id: text().notNull(),
    redeeming_kilo_user_id: text().notNull(),
    code: text().notNull(),
    amount_usd: bigint({ mode: 'number' }),
    paid_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_referral_code_usages_redeeming_kilo_user_id').on(table.redeeming_kilo_user_id),
    unique('UQ_referral_code_usages_redeeming_user_id_code').on(
      table.redeeming_kilo_user_id,
      table.referring_kilo_user_id
    ),
  ]
);

// any table with a primary key will not support incremental syncing to posthog so just add it even
// if a natural key makes more sense
const idPrimaryKeyColumn = uuid()
  .default(sql`pg_catalog.gen_random_uuid()`)
  .primaryKey()
  .notNull();

export const organizations = pgTable(
  'organizations',
  {
    id: idPrimaryKeyColumn,
    name: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    microdollars_used: bigint({ mode: 'number' })
      .default(sql`'0'`)
      .notNull(),
    // Deprecated: balance is now computed as total_microdollars_acquired - microdollars_used.
    // Kept in sync for rollback safety; will be removed in a future migration.
    microdollars_balance: bigint({ mode: 'number' })
      .default(sql`'0'`)
      .notNull(),
    total_microdollars_acquired: bigint({ mode: 'number' })
      .default(sql`'0'`)
      .notNull(),
    next_credit_expiration_at: timestamp({ withTimezone: true, mode: 'string' }),
    stripe_customer_id: text(),
    auto_top_up_enabled: boolean().default(false).notNull(),
    settings: jsonb().default({}).$type<OrganizationSettings>().notNull(),
    seat_count: integer().default(0).notNull(),
    require_seats: boolean().default(true).notNull(),
    created_by_kilo_user_id: text(),
    deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
    sso_domain: text(),
    plan: text().$type<OrganizationPlan>().notNull().default('teams'),
    free_trial_end_at: timestamp({ withTimezone: true, mode: 'string' }),
    company_domain: text(),
  },
  table => [
    check('organizations_name_not_empty_check', sql`length(trim(${table.name})) > 0`),
    index('IDX_organizations_sso_domain').on(table.sso_domain),
  ]
);

export type Organization = typeof organizations.$inferSelect;

export const organization_memberships = pgTable(
  'organization_memberships',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid().notNull(),
    kilo_user_id: text().notNull(),
    role: text().$type<OrganizationRole>().notNull(),
    joined_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    invited_by: text(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_organization_memberships_org_user').on(table.organization_id, table.kilo_user_id),
    index('IDX_organization_memberships_org_id').on(table.organization_id),
    index('IDX_organization_memberships_user_id').on(table.kilo_user_id),
  ]
);

export type OrganizationMembership = typeof organization_memberships.$inferSelect;

export const organization_membership_removals = pgTable(
  'organization_membership_removals',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid().notNull(),
    kilo_user_id: text().notNull(),
    removed_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    removed_by: text(),
    previous_role: text().$type<OrganizationRole>().notNull(),
  },
  table => [
    unique('UQ_org_membership_removals_org_user').on(table.organization_id, table.kilo_user_id),
    index('IDX_org_membership_removals_org_id').on(table.organization_id),
    index('IDX_org_membership_removals_user_id').on(table.kilo_user_id),
  ]
);

export type OrganizationMembershipRemoval = typeof organization_membership_removals.$inferSelect;

export const organization_invitations = pgTable(
  'organization_invitations',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid().notNull(),
    email: text().notNull(),
    role: text().$type<OrganizationRole>().notNull(),
    invited_by: text().notNull(),
    token: text().notNull(),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    accepted_at: timestamp({ withTimezone: true, mode: 'string' }),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('UQ_organization_invitations_token').on(table.token),
    index('IDX_organization_invitations_org_id').on(table.organization_id),
    index('IDX_organization_invitations_email').on(table.email),
    index('IDX_organization_invitations_expires_at').on(table.expires_at),
  ]
);

export type OrganizationInvitation = typeof organization_invitations.$inferSelect;

// potentially have more usage type limits in the future
export type OrganizationUserLimitType = 'daily';

export const organization_user_limits = pgTable(
  'organization_user_limits',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid().notNull(),
    kilo_user_id: text().notNull(),
    limit_type: text().$type<OrganizationUserLimitType>().notNull(),
    microdollar_limit: bigint({ mode: 'number' }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_organization_user_limits_org_user').on(
      table.organization_id,
      table.kilo_user_id,
      table.limit_type
    ),
    index('IDX_organization_user_limits_org_id').on(table.organization_id),
    index('IDX_organization_user_limits_user_id').on(table.kilo_user_id),
  ]
);

export type OrganizationUserLimit = typeof organization_user_limits.$inferSelect;

export const organization_user_usage = pgTable(
  'organization_user_usage',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid().notNull(),
    kilo_user_id: text().notNull(),
    usage_date: date().notNull(),
    limit_type: text().$type<OrganizationUserLimitType>().notNull(),
    microdollar_usage: bigint({ mode: 'number' }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_organization_user_daily_usage_org_user_date').on(
      table.organization_id,
      table.kilo_user_id,
      table.limit_type,
      table.usage_date
    ),
    index('IDX_organization_user_daily_usage_org_id').on(table.organization_id),
    index('IDX_organization_user_daily_usage_user_id').on(table.kilo_user_id),
  ]
);

export type OrganizationUserDailyUsage = typeof organization_user_usage.$inferSelect;

type SubscriptionStatus =
  | 'active'
  | 'pending_cancel'
  | 'ended'
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';
export type BillingCycle = 'monthly' | 'yearly';

export const organization_seats_purchases = pgTable(
  'organization_seats_purchases',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid().notNull(),
    subscription_stripe_id: text().notNull(),
    seat_count: integer().notNull(),
    amount_usd: decimal({ mode: 'number' }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    subscription_status: text().$type<SubscriptionStatus>().notNull().default('active'),
    idempotency_key: text()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`),
    starts_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    billing_cycle: text().$type<BillingCycle>().notNull().default('monthly'),
  },
  table => [
    index('IDX_organization_seats_org_id').on(table.organization_id),
    index('IDX_organization_seats_expires_at').on(table.expires_at),
    index('IDX_organization_seats_created_at').on(table.created_at),
    index('IDX_organization_seats_updated_at').on(table.updated_at),
    unique('UQ_organization_seats_idempotency_key').on(table.idempotency_key),
    index('IDX_organization_seats_starts_at').on(table.starts_at),
  ]
);

export type OrganizationSeatsPurchase = typeof organization_seats_purchases.$inferSelect;

export const organization_audit_logs = pgTable(
  'organization_audit_logs',
  {
    id: idPrimaryKeyColumn,
    action: text().$type<AuditLogAction>().notNull(),
    actor_id: text(),
    actor_email: text(),
    actor_name: text(),
    organization_id: uuid().notNull(),
    message: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_organization_audit_logs_organization_id').on(table.organization_id),
    index('IDX_organization_audit_logs_action').on(table.action),
    index('IDX_organization_audit_logs_actor_id').on(table.actor_id),
    index('IDX_organization_audit_logs_created_at').on(table.created_at),
  ]
);

export type AuditLog = typeof organization_audit_logs.$inferSelect;

export const ORGANIZATION_MODES_ORG_SLUG_CONSTRAINT = 'UQ_organization_modes_org_id_slug';

export const orgnaization_modes = pgTable(
  'organization_modes',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    created_by: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    config: jsonb().$type<Partial<OrganizationModeConfig>>().notNull().default({}),
  },
  table => [
    index('IDX_organization_modes_organization_id').on(table.organization_id),
    unique(ORGANIZATION_MODES_ORG_SLUG_CONSTRAINT).on(table.organization_id, table.slug),
  ]
);

export type OrganizationMode = typeof orgnaization_modes.$inferSelect;

export const enrichment_data = pgTable(
  'enrichment_data',
  {
    id: idPrimaryKeyColumn,
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id),
    github_enrichment_data: jsonb(),
    linkedin_enrichment_data: jsonb(),
    clay_enrichment_data: jsonb(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_enrichment_data_user_id').on(table.user_id),
    unique('UQ_enrichment_data_user_id').on(table.user_id),
  ]
);

export type EnrichmentData = typeof enrichment_data.$inferSelect;

// vector size 1536
export const source_embeddings = pgTable(
  'source_embeddings',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid()
      .notNull()
      .references(() => organizations.id),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id),
    project_id: text().notNull(),
    embedding: vector({ dimensions: 1536 }).notNull(),
    file_path: text().notNull(),
    file_hash: text(),
    start_line: integer().notNull(),
    end_line: integer().notNull(),
    // Git branch support fields
    git_branch: text().notNull().default('main'),
    is_base_branch: boolean().notNull().default(true),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // TODO: (bmc) add indexes to the embedding column based on what pgvector supports and what
    // works well for our use cases
    // https://github.com/pgvector/pgvector?tab=readme-ov-file#indexing
    index('IDX_source_embeddings_organization_id').on(table.organization_id),
    index('IDX_source_embeddings_kilo_user_id').on(table.kilo_user_id),
    index('IDX_source_embeddings_project_id').on(table.project_id),
    index('IDX_source_embeddings_created_at').on(table.created_at),
    index('IDX_source_embeddings_updated_at').on(table.updated_at),
    // Case-insensitive index on filePath using lowercase
    index('IDX_source_embeddings_file_path_lower').on(sql`LOWER(${table.file_path})`),
    // Git branch indexes for efficient branch-based queries
    index('IDX_source_embeddings_git_branch').on(table.git_branch),
    index('IDX_source_embeddings_org_project_branch').on(
      table.organization_id,
      table.project_id,
      table.git_branch
    ),
    // Composite unique constraint for upsert operations
    unique('UQ_source_embeddings_org_project_branch_file_lines').on(
      table.organization_id,
      table.project_id,
      table.git_branch,
      table.file_path,
      table.start_line,
      table.end_line
    ),
  ]
);

export type SourceEmbedding = typeof source_embeddings.$inferSelect;

export const platform_integrations = pgTable(
  'platform_integrations',
  {
    id: idPrimaryKeyColumn,
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    created_by_user_id: text(),

    // Platform (examples: 'github', 'gitlab', 'bitbucket', 'azure_devops')
    platform: text().notNull(),

    // Integration type (examples: 'app', 'oauth', 'pat', 'service_account')
    integration_type: text().notNull(),

    // Platform-specific identifiers
    platform_installation_id: text(),
    platform_account_id: text(),
    platform_account_login: text(),

    // Permissions and scope
    permissions: jsonb().$type<IntegrationPermissions>(),
    scopes: text().array(),

    // Repository access (GitHub's value: 'all' or 'selected')
    repository_access: text(), // nullable for pending installations
    repositories: jsonb().$type<PlatformRepository[]>(),
    repositories_synced_at: timestamp({ withTimezone: true, mode: 'string' }),

    // Metadata for storing additional platform-specific data (e.g., pending approval info)
    metadata: jsonb(),

    // Requester columns for faster queries (denormalized from metadata)
    kilo_requester_user_id: text(), // Kilo user ID who requested the installation
    platform_requester_account_id: text(), // Platform account ID (e.g., GitHub user ID) who requested

    // Integration Status (Kilo's status tracking)
    integration_status: text(), // 'pending' | 'active' | 'suspended'

    suspended_at: timestamp({ withTimezone: true, mode: 'string' }),
    suspended_by: text(),

    // GitHub App type (for GitHub platform only)
    // 'standard' = full KiloConnect app, 'lite' = read-only KiloConnect-Lite app
    github_app_type: text().$type<'standard' | 'lite'>().default('standard'),

    // Timestamps
    installed_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Allow multiple GitHub installations per org - removed old unique constraint on (org, platform)
    uniqueIndex('UQ_platform_integrations_owned_by_org_platform_inst')
      .on(table.owned_by_organization_id, table.platform, table.platform_installation_id)
      .where(isNotNull(table.owned_by_organization_id)),
    uniqueIndex('UQ_platform_integrations_owned_by_user_platform_inst')
      .on(table.owned_by_user_id, table.platform, table.platform_installation_id)
      .where(isNotNull(table.owned_by_user_id)),
    uniqueIndex('UQ_platform_integrations_slack_platform_inst')
      .on(table.platform, table.platform_installation_id)
      .where(sql`${table.platform} = 'slack' AND ${table.platform_installation_id} IS NOT NULL`),
    uniqueIndex('UQ_platform_integrations_linear_platform_inst')
      .on(table.platform, table.platform_installation_id)
      .where(sql`${table.platform} = 'linear' AND ${table.platform_installation_id} IS NOT NULL`),
    index('IDX_platform_integrations_owned_by_org_id').on(table.owned_by_organization_id),
    index('IDX_platform_integrations_owned_by_user_id').on(table.owned_by_user_id),
    index('IDX_platform_integrations_platform_inst_id').on(table.platform_installation_id),
    index('IDX_platform_integrations_platform').on(table.platform),
    index('IDX_platform_integrations_owned_by_org_platform').on(
      table.owned_by_organization_id,
      table.platform
    ),
    index('IDX_platform_integrations_owned_by_user_platform').on(
      table.owned_by_user_id,
      table.platform
    ),
    index('IDX_platform_integrations_integration_status').on(table.integration_status),
    // Indexes for requester-based queries (pending installation lookups)
    index('IDX_platform_integrations_kilo_requester').on(
      table.platform,
      table.kilo_requester_user_id,
      table.integration_status
    ),
    index('IDX_platform_integrations_platform_requester').on(
      table.platform,
      table.platform_requester_account_id,
      table.integration_status
    ),
    check(
      'platform_integrations_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
  ]
);

export type PlatformIntegration = typeof platform_integrations.$inferSelect;

// User Deployments

export const deployments = pgTable(
  'deployments',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    created_by_user_id: text(),
    owned_by_user_id: text().references(() => kilocode_users.id),
    owned_by_organization_id: uuid().references(() => organizations.id),
    deployment_slug: text().notNull(),
    internal_worker_name: text().notNull(), // Actual CF worker name
    repository_source: text().notNull(),
    branch: text().notNull(),
    deployment_url: text().notNull(),
    platform_integration_id: uuid(),
    source_type: text().notNull().default('github').$type<Provider>(),
    git_auth_token: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    last_deployed_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_build_id: uuid().notNull(),
    threat_status: text().$type<'pending_scan' | 'safe' | 'flagged'>(),
    created_from: text().$type<'deploy' | 'app-builder'>(),
  },
  table => [
    index('idx_deployments_owned_by_user_id').on(table.owned_by_user_id),
    index('idx_deployments_owned_by_organization_id').on(table.owned_by_organization_id),
    index('idx_deployments_platform_integration_id').on(table.platform_integration_id),
    index('idx_deployments_repository_source_branch').on(table.repository_source, table.branch),
    unique('UQ_deployments_deployment_slug').on(table.deployment_slug),
    index('idx_deployments_threat_status_pending')
      .on(table.threat_status)
      .where(sql`${table.threat_status} = 'pending_scan'`),
    check(
      'deployments_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
    check(
      'deployments_source_type_check',
      sql`${table.source_type} IN ('github', 'git', 'app-builder')`
    ),
  ]
);

export type Deployment = typeof deployments.$inferSelect;
export const deployment_env_vars = pgTable(
  'deployment_env_vars',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    deployment_id: uuid()
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: text().notNull(),
    is_secret: boolean().notNull().default(false),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('idx_deployment_env_vars_deployment_id').on(table.deployment_id),
    unique('UQ_deployment_env_vars_deployment_key').on(table.deployment_id, table.key),
  ]
);

export type DeploymentEnvVar = typeof deployment_env_vars.$inferSelect;

export const deployment_builds = pgTable(
  'deployment_builds',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    deployment_id: uuid()
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    status: text().notNull().$type<BuildStatus>(),
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    completed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('idx_deployment_builds_deployment_id').on(table.deployment_id),
    index('idx_deployment_builds_status').on(table.status),
  ]
);

export type DeploymentBuild = typeof deployment_builds.$inferSelect;

export const deployment_events = pgTable(
  'deployment_events',
  {
    build_id: uuid()
      .notNull()
      .references(() => deployment_builds.id, { onDelete: 'cascade' }),
    event_id: integer().notNull(),
    event_type: text().notNull().default('log').$type<'log' | 'status_change'>(),
    timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    payload: jsonb().notNull(),
  },
  table => [
    primaryKey({ columns: [table.build_id, table.event_id] }),
    index('idx_deployment_events_build_id').on(table.build_id),
    index('idx_deployment_events_timestamp').on(table.timestamp),
    index('idx_deployment_events_type').on(table.event_type),
  ]
);

export type DeploymentEvent = typeof deployment_events.$inferSelect;

export const deployment_threat_detections = pgTable(
  'deployment_threat_detections',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    deployment_id: uuid()
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    build_id: uuid().references(() => deployment_builds.id, { onDelete: 'set null' }),
    threat_type: text().notNull(), // 'MALWARE' | 'SOCIAL_ENGINEERING' | 'UNWANTED_SOFTWARE' or comma-separated
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('idx_deployment_threat_detections_deployment_id').on(table.deployment_id),
    index('idx_deployment_threat_detections_created_at').on(table.created_at),
  ]
);

export type DeploymentThreatDetection = typeof deployment_threat_detections.$inferSelect;

export const code_indexing_search = pgTable(
  'code_indexing_search',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    organization_id: uuid().notNull(),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id),
    query: text().notNull(),
    project_id: text().notNull(),
    metadata: jsonb().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_code_indexing_search_organization_id').on(table.organization_id),
    index('IDX_code_indexing_search_kilo_user_id').on(table.kilo_user_id),
    index('IDX_code_indexing_search_project_id').on(table.organization_id, table.project_id),
    index('IDX_code_indexing_search_created_at').on(table.created_at),
  ]
);

export type CodeIndexingSearch = typeof code_indexing_search.$inferSelect;

export const code_indexing_manifest = pgTable(
  'code_indexing_manifest',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    organization_id: uuid().notNull(),
    kilo_user_id: text().references(() => kilocode_users.id),
    project_id: text().notNull(),
    git_branch: text().notNull(),
    file_hash: text().notNull(),
    file_path: text().notNull(),
    chunk_count: integer().notNull(),
    total_lines: integer(),
    total_ai_lines: integer(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_code_indexing_manifest_organization_id').on(table.organization_id),
    index('IDX_code_indexing_manifest_kilo_user_id').on(table.kilo_user_id),
    index('IDX_code_indexing_manifest_project_id').on(table.project_id),
    index('IDX_code_indexing_manifest_git_branch').on(table.git_branch),
    index('IDX_code_indexing_manifest_created_at').on(table.created_at),
    // Unique index to prevent race conditions during concurrent indexing
    // Using unique constraint with nullsNotDistinct to treat NULL values as equal
    unique('UQ_code_indexing_manifest_org_user_project_hash_branch')
      .on(
        table.organization_id,
        table.kilo_user_id,
        table.project_id,
        table.file_path,
        table.git_branch
      )
      .nullsNotDistinct(),
  ]
);

export type CodeIndexingManifest = typeof code_indexing_manifest.$inferSelect;

export const agent_configs = pgTable(
  'agent_configs',
  {
    id: idPrimaryKeyColumn,
    // Ownership: exactly one must be set (org OR user)
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),

    // Agent type (examples: 'code_review', 'security_scan')
    agent_type: text().notNull(),

    // Platform (examples: 'github', 'gitlab', 'bitbucket', 'all')
    platform: text().notNull(),

    // Agent configuration (JSONB for flexibility)
    // Example for code_review:
    // {
    //   "review_style": "balanced",
    //   "focus_areas": ["security", "performance"],
    //   "model_slug": "anthropic/claude-4.5-sonnet",
    //   "max_review_time_minutes": 10,
    //   "custom_instructions": "..."
    // }
    config: jsonb().$type<CodeReviewAgentConfig | Record<string, unknown>>().notNull().default({}),

    // Status
    is_enabled: boolean().notNull().default(true),

    // Generic runtime state (e.g. security_scan agents store { last_synced_at: string })
    runtime_state: jsonb().$type<Record<string, unknown>>().default({}),

    // Metadata
    created_by: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Unique constraints for org and user ownership
    unique('UQ_agent_configs_org_agent_platform').on(
      table.owned_by_organization_id,
      table.agent_type,
      table.platform
    ),
    unique('UQ_agent_configs_user_agent_platform').on(
      table.owned_by_user_id,
      table.agent_type,
      table.platform
    ),
    // Indexes
    index('IDX_agent_configs_org_id').on(table.owned_by_organization_id),
    index('IDX_agent_configs_owned_by_user_id').on(table.owned_by_user_id),
    index('IDX_agent_configs_agent_type').on(table.agent_type),
    index('IDX_agent_configs_platform').on(table.platform),
    // Owner check constraint (exactly one must be set)
    check(
      'agent_configs_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
    check(
      'agent_configs_agent_type_check',
      sql`${table.agent_type} IN ('code_review', 'auto_triage', 'auto_fix', 'security_scan')`
    ),
  ]
);

export const webhook_events = pgTable(
  'webhook_events',
  {
    id: idPrimaryKeyColumn,
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),

    // Platform (examples: 'github', 'gitlab', 'bitbucket')
    platform: text().notNull(),

    // Event type (examples: 'pull_request', 'push', 'installation', 'merge_request')
    event_type: text().notNull(),

    // Event action (examples: 'opened', 'synchronize', 'created', 'merged')
    event_action: text(),

    // Event data
    payload: jsonb().notNull(),
    headers: jsonb().notNull(),

    // Processing status
    processed: boolean().notNull().default(false),
    processed_at: timestamp({ withTimezone: true, mode: 'string' }),
    handlers_triggered: text().array().default([]).notNull(),
    errors: jsonb(),

    // Deduplication
    event_signature: text().notNull(),

    // Timestamp
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_webhook_events_signature').on(table.event_signature),
    index('IDX_webhook_events_owned_by_org_id').on(table.owned_by_organization_id),
    index('IDX_webhook_events_owned_by_user_id').on(table.owned_by_user_id),
    index('IDX_webhook_events_platform').on(table.platform),
    index('IDX_webhook_events_event_type').on(table.event_type),
    index('IDX_webhook_events_created_at').on(table.created_at),
    check(
      'webhook_events_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
  ]
);

// ============ WEBHOOK TRIGGERS ============
// Registry for webhook triggers - PostgreSQL is listing/ownership index only
// Authoritative config data lives in the worker's TriggerDO

export const cloud_agent_webhook_triggers = pgTable(
  'cloud_agent_webhook_triggers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trigger_id: text('trigger_id').notNull(),
    user_id: text('user_id').references(() => kilocode_users.id, { onDelete: 'cascade' }),
    organization_id: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    // Target type: 'cloud_agent' (default) or 'kiloclaw_chat'
    target_type: text('target_type').notNull().default('cloud_agent'),
    // KiloClaw Chat target: which instance to send messages to
    kiloclaw_instance_id: uuid('kiloclaw_instance_id').references(() => kiloclaw_instances.id),
    // Activation mode: 'webhook' (default) or 'scheduled' (cron-based)
    activation_mode: text('activation_mode').notNull().default('webhook'),
    // Scheduled trigger fields (only applicable when activation_mode = 'scheduled')
    cron_expression: text('cron_expression'),
    cron_timezone: text('cron_timezone').default('UTC'),
    // Cloud Agent target fields (nullable — only required when target_type = 'cloud_agent')
    github_repo: text('github_repo'),
    is_active: boolean('is_active').notNull().default(true),
    // Profile reference - resolved at runtime in the worker via Hyperdrive
    // ON DELETE RESTRICT prevents deletion of profiles referenced by triggers
    // Nullable — only required when target_type = 'cloud_agent'
    profile_id: uuid('profile_id').references(() => agent_environment_profiles.id, {
      onDelete: 'restrict',
    }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Unique indexes (partial) - trigger_id must be unique per user or per org
    uniqueIndex('UQ_cloud_agent_webhook_triggers_user_trigger')
      .on(table.user_id, table.trigger_id)
      .where(isNotNull(table.user_id)),
    uniqueIndex('UQ_cloud_agent_webhook_triggers_org_trigger')
      .on(table.organization_id, table.trigger_id)
      .where(isNotNull(table.organization_id)),
    // Indexes
    index('IDX_cloud_agent_webhook_triggers_user').on(table.user_id),
    index('IDX_cloud_agent_webhook_triggers_org').on(table.organization_id),
    index('IDX_cloud_agent_webhook_triggers_active').on(table.is_active),
    index('IDX_cloud_agent_webhook_triggers_profile').on(table.profile_id),
    // Owner check constraint - exactly one must be set
    check(
      'CHK_cloud_agent_webhook_triggers_owner',
      sql`(
        (${table.user_id} IS NOT NULL AND ${table.organization_id} IS NULL) OR
        (${table.user_id} IS NULL AND ${table.organization_id} IS NOT NULL)
      )`
    ),
    // Cloud Agent triggers require github_repo and profile_id
    check(
      'CHK_cloud_agent_webhook_triggers_cloud_agent_fields',
      sql`(
        ${table.target_type} != 'cloud_agent' OR
        (${table.github_repo} IS NOT NULL AND ${table.profile_id} IS NOT NULL)
      )`
    ),
    // KiloClaw Chat triggers require kiloclaw_instance_id
    check(
      'CHK_cloud_agent_webhook_triggers_kiloclaw_fields',
      sql`(
        ${table.target_type} != 'kiloclaw_chat' OR
        ${table.kiloclaw_instance_id} IS NOT NULL
      )`
    ),
    // Scheduled triggers require cron_expression
    check(
      'CHK_cloud_agent_webhook_triggers_scheduled_fields',
      sql`(
        ${table.activation_mode} != 'scheduled' OR
        ${table.cron_expression} IS NOT NULL
      )`
    ),
  ]
);

export type WebhookTrigger = typeof cloud_agent_webhook_triggers.$inferSelect;
export type NewWebhookTrigger = typeof cloud_agent_webhook_triggers.$inferInsert;

export const magic_link_tokens = pgTable(
  'magic_link_tokens',
  {
    token_hash: text().primaryKey().notNull(),
    email: text().notNull(),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    consumed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('idx_magic_link_tokens_email').on(table.email),
    index('idx_magic_link_tokens_expires_at').on(table.expires_at),
    check('check_expires_at_future', sql`${table.expires_at} > ${table.created_at}`),
  ]
);

export type MagicLinkToken = typeof magic_link_tokens.$inferSelect;
export type WebhookEvent = typeof webhook_events.$inferSelect;

// ============ MODEL STATS ============
// Cached model data from OpenRouter and external benchmarks

// Zod schemas for runtime validation of JSONB data
export const ModelStatsBenchmarksSchema = z
  .object({
    artificialAnalysis: z
      .object({
        codingIndex: z.number().optional(),
        liveCodeBench: z.number().optional(),
        sciCode: z.number().optional(),
        terminalBenchHard: z.number().optional(),
        lcr: z.number().optional(),
        ifBench: z.number().optional(),
        lastUpdated: z.string().optional(),
      })
      .optional(),
    kiloBench: z
      .object({
        overallScore: z.number(),
        evals: z.record(
          z.string(),
          z.object({
            taskSource: z.string(),
            displayName: z.string().optional(),
            overallScore: z.number(),
            totalScore: z.number(),
            avgCostUsd: z.number().nullable(),
            avgInputTokens: z.number().nullable(),
            avgOutputTokens: z.number().nullable(),
            avgCacheReadTokens: z.number().nullable(),
            avgExecutionMs: z.number().nullable(),
            nTotalTrials: z.number(),
            nErrored: z.number(),
            lastPromotedAt: z.string(),
          })
        ),
      })
      .optional(),
  })
  .optional();

export const ModelStatsChartDataSchema = z
  .object({
    weeklyTokenUsage: z
      .object({
        dataPoints: z.array(
          z.object({
            date: z.string(),
            tokens: z.number(),
          })
        ),
        lastUpdated: z.string(),
      })
      .optional(),
    modeRankings: z
      .object({
        architect: z.number().optional(),
        code: z.number().optional(),
        ask: z.number().optional(),
        debug: z.number().optional(),
        orchestrator: z.number().optional(),
        lastUpdated: z.string(),
      })
      .optional(),
  })
  .optional();

// TypeScript types inferred from Zod schemas
export type ModelStatsBenchmarks = z.infer<typeof ModelStatsBenchmarksSchema>;
export type ModelStatsChartData = z.infer<typeof ModelStatsChartDataSchema>;

export const modelStats = pgTable(
  'model_stats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    isActive: boolean('is_active').default(true),
    isFeatured: boolean('is_featured').default(false).notNull(),
    isStealth: boolean('is_stealth').default(false).notNull(),
    isRecommended: boolean('is_recommended').default(false).notNull(),

    // ============ IDENTIFIERS ============
    openrouterId: text('openrouter_id').notNull().unique(),
    slug: text('slug').unique(),
    aaSlug: text('aa_slug'),

    // ============ CORE DISPLAY DATA ============
    name: text('name').notNull(),
    description: text('description'),
    modelCreator: text('model_creator'),
    creatorSlug: text('creator_slug'),
    releaseDate: date('release_date'),

    // ============ DENORMALIZED FIELDS (for fast queries/sorts) ============
    // Pricing (from OpenRouter)
    priceInput: decimal('price_input', { precision: 10, scale: 6 }),
    priceOutput: decimal('price_output', { precision: 10, scale: 6 }),

    // Performance (from Artificial Analysis)
    codingIndex: decimal('coding_index', { precision: 5, scale: 2 }),
    speedTokensPerSec: decimal('speed_tokens_per_sec', { precision: 8, scale: 2 }),

    // Technical specs (from OpenRouter)
    contextLength: integer('context_length'),
    maxOutputTokens: integer('max_output_tokens'),
    inputModalities: text('input_modalities').array(),

    // ============ COMPLETE DATA BLOBS ============
    openrouterData: jsonb('openrouter_data').$type<OpenRouterModel>().notNull(),
    benchmarks: jsonb('benchmarks').$type<ModelStatsBenchmarks>(),

    // ============ CHART DATA ============
    chartData: jsonb('chart_data').$type<ModelStatsChartData>(),

    // ============ METADATA ============
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Indexes for common queries
    index('IDX_model_stats_openrouter_id').on(table.openrouterId),
    index('IDX_model_stats_slug').on(table.slug),
    index('IDX_model_stats_is_active').on(table.isActive),
    index('IDX_model_stats_creator_slug').on(table.creatorSlug),

    // Indexes for sorting/filtering
    index('IDX_model_stats_price_input').on(table.priceInput),
    index('IDX_model_stats_coding_index').on(table.codingIndex),
    index('IDX_model_stats_context_length').on(table.contextLength),
  ]
);

export type ModelStats = typeof modelStats.$inferSelect;
export type NewModelStats = typeof modelStats.$inferInsert;

export const model_eval_ingestions = pgTable(
  'model_eval_ingestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bench_eval_name: text('bench_eval_name').notNull().unique(),
    bench_eval_url: text('bench_eval_url').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    model_stats_id: uuid('model_stats_id').references(() => modelStats.id),
    variant: text('variant'),
    task_source: text('task_source').notNull(),
    n_total_trials: integer('n_total_trials').notNull(),
    total_score: decimal('total_score', { precision: 14, scale: 6, mode: 'number' }).notNull(),
    overall_score: decimal('overall_score', { precision: 12, scale: 8, mode: 'number' }).notNull(),
    n_errored: integer('n_errored').notNull(),
    avg_cost_microdollars: bigint('avg_cost_microdollars', { mode: 'number' }),
    avg_input_tokens: integer('avg_input_tokens'),
    avg_output_tokens: integer('avg_output_tokens'),
    avg_cache_read_tokens: integer('avg_cache_read_tokens'),
    avg_execution_ms: integer('avg_execution_ms'),
    promoted_at: timestamp('promoted_at', { withTimezone: true, mode: 'string' }).notNull(),
    promoted_by_email: text('promoted_by_email').notNull(),
    promotion_note: text('promotion_note'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  table => [
    index('IDX_model_eval_ingestions_lookup').on(
      table.provider,
      table.model,
      table.variant,
      table.task_source,
      table.promoted_at
    ),
    index('IDX_model_eval_ingestions_model_stats').on(table.model_stats_id),
    index('IDX_model_eval_ingestions_promoted_by_email_lower').on(
      sql`LOWER(${table.promoted_by_email})`
    ),
  ]
);

export type ModelEvalIngestion = typeof model_eval_ingestions.$inferSelect;
export type NewModelEvalIngestion = typeof model_eval_ingestions.$inferInsert;

export const MODELS_BY_PROVIDER_ADMIN_URL = '/admin/sync-providers';

export const contributor_champion_contributors = pgTable(
  'contributor_champion_contributors',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    github_login: text().notNull(),
    github_profile_url: text().notNull(),
    github_user_id: bigint({ mode: 'number' }),
    first_contribution_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_contribution_at: timestamp({ withTimezone: true, mode: 'string' }),
    all_time_contributions: integer().notNull().default(0),
    manual_email: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_contributor_champion_contributors_github_login').on(table.github_login),
    index('IDX_contributor_champion_contributors_last_contribution_at').on(
      table.last_contribution_at
    ),
    index('IDX_contributor_champion_contributors_manual_email').on(table.manual_email),
  ]
);

export type ContributorChampionContributor = typeof contributor_champion_contributors.$inferSelect;

export const contributor_champion_events = pgTable(
  'contributor_champion_events',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    contributor_id: uuid()
      .notNull()
      .references(() => contributor_champion_contributors.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    repo_full_name: text().notNull(),
    github_pr_number: integer().notNull(),
    github_pr_url: text().notNull(),
    github_pr_title: text().notNull(),
    github_author_login: text().notNull(),
    github_author_email: text(),
    merged_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    unique('UQ_contributor_champion_events_repo_pr').on(
      table.repo_full_name,
      table.github_pr_number
    ),
    index('IDX_contributor_champion_events_contributor_id').on(table.contributor_id),
    index('IDX_contributor_champion_events_merged_at').on(table.merged_at),
    index('IDX_contributor_champion_events_author_email').on(table.github_author_email),
  ]
);

export type ContributorChampionEvent = typeof contributor_champion_events.$inferSelect;

export const contributor_champion_memberships = pgTable(
  'contributor_champion_memberships',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    contributor_id: uuid()
      .notNull()
      .references(() => contributor_champion_contributors.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    selected_tier: text().$type<ContributorChampionTier>(),
    enrolled_tier: text().$type<ContributorChampionTier>(),
    enrolled_at: timestamp({ withTimezone: true, mode: 'string' }),
    credit_amount_microdollars: bigint({ mode: 'number' }).default(0).notNull(),
    credits_last_granted_at: timestamp({ withTimezone: true, mode: 'string' }),
    linked_kilo_user_id: text().references(() => kilocode_users.id, { onDelete: 'set null' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_contributor_champion_memberships_contributor_id').on(table.contributor_id),
    check(
      'contributor_champion_memberships_selected_tier_check',
      sql`${table.selected_tier} IS NULL OR ${table.selected_tier} IN ('contributor', 'ambassador', 'champion')`
    ),
    check(
      'contributor_champion_memberships_enrolled_tier_check',
      sql`${table.enrolled_tier} IS NULL OR ${table.enrolled_tier} IN ('contributor', 'ambassador', 'champion')`
    ),
    index('IDX_contributor_champion_memberships_credits_due')
      .on(table.credits_last_granted_at)
      .where(sql`${table.enrolled_tier} IS NOT NULL AND ${table.credit_amount_microdollars} > 0`),
    index('IDX_contributor_champion_memberships_linked_kilo_user_id').on(table.linked_kilo_user_id),
  ]
);

export type ContributorChampionMembership = typeof contributor_champion_memberships.$inferSelect;

export const contributor_champion_sync_state = pgTable('contributor_champion_sync_state', {
  repo_full_name: text().primaryKey().notNull(),
  last_merged_at: timestamp({ withTimezone: true, mode: 'string' }),
  last_synced_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => sql`now()`),
});

export type ContributorChampionSyncState = typeof contributor_champion_sync_state.$inferSelect;

export const modelsByProvider = pgTable('models_by_provider', {
  id: serial().notNull().primaryKey(),
  data: jsonb('data').$type<NormalizedOpenRouterResponse>().notNull(),
  openrouter: jsonb('openrouter').$type<Record<string, StoredModel>>(),
  vercel: jsonb('vercel').$type<Record<string, StoredModel>>(),
});

export const cloud_agent_code_reviews = pgTable(
  'cloud_agent_code_reviews',
  {
    id: idPrimaryKeyColumn,
    // Ownership: exactly one must be set (org OR user)
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),

    // Platform integration (optional - for linking to integration)
    platform_integration_id: uuid().references(() => platform_integrations.id, {
      onDelete: 'set null',
    }),

    // PR information
    repo_full_name: text().notNull(), // e.g., "owner/repo"
    pr_number: integer().notNull(),
    pr_url: text().notNull(),
    pr_title: text().notNull(),
    pr_author: text().notNull(),
    pr_author_github_id: text(),
    base_ref: text().notNull(), // Base branch (e.g., "main")
    head_ref: text().notNull(), // PR branch (e.g., "feature/xyz")
    head_sha: text().notNull(), // Latest commit SHA

    // Platform (github, gitlab, etc.)
    platform: text().notNull().default('github'),

    // Platform-specific project ID (e.g., GitLab numeric project ID)
    platform_project_id: integer(),

    // Cloud agent session
    session_id: text(), // Cloud agent session ID (agent_xxx)
    cli_session_id: text(), // Kilo CLI session ID (ses_xxx from cli_sessions_v2, or legacy UUID from cli_sessions v1)

    // Review status
    status: text().notNull().default('pending'), // 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
    error_message: text(),
    terminal_reason: text(),

    // Which cloud agent backend executed this review: 'v1' (cloud-agent SSE) or 'v2' (cloud-agent-next)
    agent_version: text().default('v1'),

    // PR gate check tracking
    // GitHub Check Run ID; null for GitLab or pre-feature reviews
    check_run_id: bigint({ mode: 'number' }),

    // REVIEW.md usage metadata
    repository_review_instructions_used: boolean().notNull().default(false),
    repository_review_instructions_ref: text(),
    repository_review_instructions_truncated: boolean().notNull().default(false),

    // Usage tracking (populated on completion by orchestrator)
    model: text(), // LLM model slug used (e.g., 'anthropic/claude-sonnet-4.6')
    total_tokens_in: integer(), // Total input tokens across all LLM calls
    total_tokens_out: integer(), // Total output tokens across all LLM calls
    total_cost_musd: integer(), // Total cost in microdollars (for consistency with microdollar_usage)

    // Timestamps
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    completed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Unique constraint: one review per repo+PR+SHA combination
    uniqueIndex('UQ_cloud_agent_code_reviews_repo_pr_sha').on(
      table.repo_full_name,
      table.pr_number,
      table.head_sha
    ),
    // Indexes for ownership lookups
    index('idx_cloud_agent_code_reviews_owned_by_org_id').on(table.owned_by_organization_id),
    index('idx_cloud_agent_code_reviews_owned_by_user_id').on(table.owned_by_user_id),
    // Indexes for session and status lookups
    index('idx_cloud_agent_code_reviews_session_id').on(table.session_id),
    index('idx_cloud_agent_code_reviews_cli_session_id').on(table.cli_session_id),
    index('idx_cloud_agent_code_reviews_status').on(table.status),
    // Indexes for repo and PR lookups
    index('idx_cloud_agent_code_reviews_repo').on(table.repo_full_name),
    index('idx_cloud_agent_code_reviews_pr_number').on(table.repo_full_name, table.pr_number),
    // Index for sorting by creation date
    index('idx_cloud_agent_code_reviews_created_at').on(table.created_at),
    // Index for GitHub ID lookups
    index('idx_cloud_agent_code_reviews_pr_author_github_id').on(table.pr_author_github_id),
    // Owner check constraint (exactly one must be set)
    check(
      'cloud_agent_code_reviews_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
  ]
);

export type CloudAgentCodeReview = typeof cloud_agent_code_reviews.$inferSelect;

export const cloud_agent_code_review_attempts = pgTable(
  'cloud_agent_code_review_attempts',
  {
    id: idPrimaryKeyColumn,
    code_review_id: uuid()
      .notNull()
      .references(() => cloud_agent_code_reviews.id, { onDelete: 'cascade' }),
    attempt_number: integer().notNull(),
    retry_of_attempt_id: uuid().references((): AnyPgColumn => cloud_agent_code_review_attempts.id, {
      onDelete: 'set null',
    }),
    retry_reason: text(),
    session_id: text(),
    cli_session_id: text(),
    execution_id: text(),
    status: text().notNull().default('pending'),
    error_message: text(),
    terminal_reason: text(),
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    completed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_cloud_agent_code_review_attempts_review_attempt_number').on(
      table.code_review_id,
      table.attempt_number
    ),
    index('idx_cloud_agent_code_review_attempts_code_review_id').on(table.code_review_id),
    index('idx_cloud_agent_code_review_attempts_session_id').on(table.session_id),
    index('idx_cloud_agent_code_review_attempts_cli_session_id').on(table.cli_session_id),
    index('idx_cloud_agent_code_review_attempts_status').on(table.status),
    index('idx_cloud_agent_code_review_attempts_retry_reason').on(table.retry_reason),
    check(
      'cloud_agent_code_review_attempts_attempt_number_check',
      sql`${table.attempt_number} >= 1`
    ),
  ]
);

export type CloudAgentCodeReviewAttempt = typeof cloud_agent_code_review_attempts.$inferSelect;

export const cliSessions = pgTable(
  'cli_sessions',
  {
    session_id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    created_on_platform: text().notNull().default('unknown'),
    api_conversation_history_blob_url: text(),
    task_metadata_blob_url: text(),
    ui_messages_blob_url: text(),
    git_state_blob_url: text(),
    git_url: text(),
    forked_from: uuid().references((): AnyPgColumn => cliSessions.session_id, {
      onDelete: 'set null',
    }),
    parent_session_id: uuid().references((): AnyPgColumn => cliSessions.session_id, {
      onDelete: 'set null',
    }),
    cloud_agent_session_id: text().unique(),
    organization_id: uuid().references(() => organizations.id, { onDelete: 'set null' }),
    last_mode: text(),
    last_model: text(),
    version: integer().notNull().default(0),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_cli_sessions_kilo_user_id').on(table.kilo_user_id),
    index('IDX_cli_sessions_created_at').on(table.created_at),
    index('IDX_cli_sessions_updated_at').on(table.updated_at),
    index('IDX_cli_sessions_organization_id').on(table.organization_id),
    index('IDX_cli_sessions_user_updated').on(table.kilo_user_id, table.updated_at),
  ]
);

export type CliSession = typeof cliSessions.$inferSelect;

export const sharedCliSessions = pgTable(
  'shared_cli_sessions',
  {
    share_id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    session_id: uuid().references(() => cliSessions.session_id, { onDelete: 'set null' }),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'restrict' }),
    shared_state: text().default(CliSessionSharedState.Public).notNull(),
    api_conversation_history_blob_url: text(),
    task_metadata_blob_url: text(),
    ui_messages_blob_url: text(),
    git_state_blob_url: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_shared_cli_sessions_session_id').on(table.session_id),
    index('IDX_shared_cli_sessions_created_at').on(table.created_at),
    enumCheck('shared_cli_sessions_shared_state_check', table.shared_state, CliSessionSharedState),
  ]
);

export type SharedCliSession = typeof sharedCliSessions.$inferSelect;

export const cli_sessions_v2 = pgTable(
  'cli_sessions_v2',
  {
    session_id: text().notNull(),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'restrict' }),
    version: integer().notNull().default(0),
    title: text(),
    public_id: uuid(),
    parent_session_id: text(),
    organization_id: uuid().references(() => organizations.id, { onDelete: 'set null' }),
    cloud_agent_session_id: text(),
    created_on_platform: text().notNull().default('unknown'),
    git_url: text(),
    git_branch: text(),
    status: text(),
    status_updated_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    primaryKey({ columns: [table.session_id, table.kilo_user_id] }),
    foreignKey({
      columns: [table.parent_session_id, table.kilo_user_id],
      foreignColumns: [table.session_id, table.kilo_user_id],
      name: 'cli_sessions_v2_parent_session_id_kilo_user_id_fk',
    }).onDelete('restrict'),
    index('IDX_cli_sessions_v2_parent_session_id_kilo_user_id').on(
      table.parent_session_id,
      table.kilo_user_id
    ),
    uniqueIndex('UQ_cli_sessions_v2_public_id')
      .on(table.public_id)
      .where(isNotNull(table.public_id)),
    uniqueIndex('UQ_cli_sessions_v2_cloud_agent_session_id')
      .on(table.cloud_agent_session_id)
      .where(isNotNull(table.cloud_agent_session_id)),
    index('IDX_cli_sessions_v2_organization_id').on(table.organization_id),
    index('IDX_cli_sessions_v2_kilo_user_id').on(table.kilo_user_id),
    index('IDX_cli_sessions_v2_created_at').on(table.created_at),
    index('IDX_cli_sessions_v2_user_updated').on(table.kilo_user_id, table.updated_at),
    // Supports joins from github_branch_pull_requests on (git_url, git_branch).
    index('cli_sessions_v2_git_url_branch_idx').on(table.git_url, table.git_branch),
  ]
);

export type CliSessionV2 = typeof cli_sessions_v2.$inferSelect;
export type NewCliSessionV2 = typeof cli_sessions_v2.$inferInsert;

/**
 * Per-tenant cache of the latest GitHub pull request observed for a
 * `(repo, branch)` pair. Written by the `pull_request` webhook handler
 * and the manual `refreshAssociatedPullRequest` mutation; read by the
 * cli-sessions-v2 router to attach `associatedPr` to a session.
 *
 * Tenancy: XOR ownership columns mirror `platform_integrations`. A webhook
 * delivery from an org installation writes a row under that org; a user
 * installation writes under the user. Different tenants caching the same
 * `(git_url, git_branch)` produce separate rows and never contaminate
 * each other's reads.
 *
 * `git_url` is always stored in normalized form (see `normalizeGitUrl` in
 * `@kilocode/worker-utils`). Session rows must store `git_url` in the same
 * normalized shape for the join to match — the session-ingest queue consumer
 * enforces this on write for new sessions.
 */
export const github_branch_pull_requests = pgTable(
  'github_branch_pull_requests',
  {
    git_url: text().notNull(),
    git_branch: text().notNull(),
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    // pr_url/pr_number/pr_state are nullable so we can persist a "no PR exists
    // for this branch" sentinel row: pr_last_synced_at then throttles repeated
    // refresh attempts even when GitHub has no matching PR.
    pr_url: text(),
    pr_number: integer(),
    pr_state: text(),
    pr_title: text(),
    pr_head_sha: text(),
    pr_review_decision: text(),
    review_decision_pending: boolean().notNull().default(false),
    review_decision_fetching_at: timestamp({ withTimezone: true, mode: 'string' }),
    pr_last_synced_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Partial unique indexes serve as ON CONFLICT targets for the webhook
    // upsert. Identity columns (git_url, git_branch) lead; tenant column
    // trails since all hot-path reads supply every column anyway.
    uniqueIndex('UQ_github_branch_prs_org')
      .on(table.git_url, table.git_branch, table.owned_by_organization_id)
      .where(isNotNull(table.owned_by_organization_id)),
    uniqueIndex('UQ_github_branch_prs_user')
      .on(table.git_url, table.git_branch, table.owned_by_user_id)
      .where(isNotNull(table.owned_by_user_id)),
    check(
      'github_branch_pull_requests_owner_check',
      sql`(
        (${table.owned_by_organization_id} IS NOT NULL AND ${table.owned_by_user_id} IS NULL) OR
        (${table.owned_by_organization_id} IS NULL AND ${table.owned_by_user_id} IS NOT NULL)
      )`
    ),
    check(
      'github_branch_pull_requests_review_decision_check',
      sql`${table.pr_review_decision} IS NULL OR ${table.pr_review_decision} IN ('approved', 'changes_requested', 'review_required')`
    ),
  ]
);

export type GithubBranchPullRequest = typeof github_branch_pull_requests.$inferSelect;
export type NewGithubBranchPullRequest = typeof github_branch_pull_requests.$inferInsert;

export const device_auth_requests = pgTable(
  'device_auth_requests',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    code: text().notNull(),
    kilo_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    status: text()
      .$type<'pending' | 'approved' | 'denied' | 'expired'>()
      .notNull()
      .default('pending'),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    approved_at: timestamp({ withTimezone: true, mode: 'string' }),
    user_agent: text(),
    ip_address: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_device_auth_requests_code').on(table.code),
    index('IDX_device_auth_requests_status').on(table.status),
    index('IDX_device_auth_requests_expires_at').on(table.expires_at),
    index('IDX_device_auth_requests_kilo_user_id').on(table.kilo_user_id),
  ]
);

export type DeviceAuthRequest = typeof device_auth_requests.$inferSelect;

// App Builder Projects
export const app_builder_projects = pgTable(
  'app_builder_projects',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    created_by_user_id: text(),
    owned_by_user_id: text().references(() => kilocode_users.id),
    owned_by_organization_id: uuid().references(() => organizations.id),
    session_id: text(), // Cloud Agent session ID
    title: text().notNull(),
    model_id: text().notNull(),
    template: text(), // nullable - null means default template (nextjs-starter)
    deployment_id: uuid().references(() => deployments.id, { onDelete: 'set null' }),
    last_message_at: timestamp({ withTimezone: true, mode: 'string' }),
    // Git platform migration fields (GitHub, GitLab, etc.)
    git_repo_full_name: text(), // "owner/repo" after migration
    git_platform_integration_id: uuid().references(() => platform_integrations.id, {
      onDelete: 'set null',
    }), // platform_integrations.platform tells us which platform (github, gitlab, etc.)
    migrated_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_app_builder_projects_created_by_user_id').on(table.created_by_user_id),
    index('IDX_app_builder_projects_owned_by_user_id').on(table.owned_by_user_id),
    index('IDX_app_builder_projects_owned_by_organization_id').on(table.owned_by_organization_id),
    index('IDX_app_builder_projects_created_at').on(table.created_at),
    index('IDX_app_builder_projects_last_message_at').on(table.last_message_at),
    index('IDX_app_builder_projects_git_repo_integration')
      .on(table.git_repo_full_name, table.git_platform_integration_id)
      .where(isNotNull(table.git_repo_full_name)),
    check(
      'app_builder_projects_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
  ]
);

export type AppBuilderProject = typeof app_builder_projects.$inferSelect;

// App Builder Project Sessions - tracks all Cloud Agent sessions per project
export const AppBuilderSessionReason = {
  Initial: 'initial', // First session created with project
  GitHubMigration: 'github_migration', // New session after migrating to GitHub
  Upgrade: 'upgrade', // New session after worker version upgrade (v1→v2)
  ModelVisionChange: 'model_vision_change', // New session after switching between vision and text-only models
  UserInitiated: 'user_initiated', // New session explicitly started by the user via "New Chat"
} satisfies Record<string, string>;

export const app_builder_project_sessions = pgTable(
  'app_builder_project_sessions',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    project_id: uuid()
      .references(() => app_builder_projects.id, { onDelete: 'cascade' })
      .notNull(),
    cloud_agent_session_id: text().notNull(), // "agent_xxx"
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    ended_at: timestamp({ withTimezone: true, mode: 'string' }), // null = current/active session
    reason: text().notNull(), // 'initial', 'github_migration', 'upgrade', etc.
    worker_version: text().notNull().default('v2'), // 'v1' (legacy/R2 only) or 'v2' (cloud-agent-next)
  },
  table => [
    index('IDX_app_builder_project_sessions_project_id').on(table.project_id),
    unique('UQ_app_builder_project_sessions_cloud_agent_session_id').on(
      table.cloud_agent_session_id
    ),
  ]
);

export const app_reported_messages = pgTable('app_reported_messages', {
  report_id: uuid()
    .default(sql`pg_catalog.gen_random_uuid()`)
    .primaryKey()
    .notNull(),
  report_type: text().notNull(),
  signature: jsonb().$type<Record<string, unknown>>().notNull(),
  message: jsonb().$type<Record<string, unknown>>().notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  cli_session_id: uuid().references(() => cliSessions.session_id, { onDelete: 'set null' }),
  mode: text(),
  model: text(),
});

export type AppReportedMessage = typeof app_reported_messages.$inferSelect;

export const byok_api_keys = pgTable(
  'byok_api_keys',
  {
    id: idPrimaryKeyColumn,
    organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    kilo_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    provider_id: text().notNull(),
    encrypted_api_key: jsonb().$type<EncryptedData>().notNull(),
    is_enabled: boolean().default(true).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    created_by: text().notNull(),
  },
  table => [
    // Unique constraints for org and user ownership
    unique('UQ_byok_api_keys_org_provider').on(table.organization_id, table.provider_id),
    unique('UQ_byok_api_keys_user_provider').on(table.kilo_user_id, table.provider_id),
    // Indexes
    index('IDX_byok_api_keys_organization_id').on(table.organization_id),
    index('IDX_byok_api_keys_kilo_user_id').on(table.kilo_user_id),
    index('IDX_byok_api_keys_provider_id').on(table.provider_id),
    // Owner check constraint (exactly one must be set)
    check(
      'byok_api_keys_owner_check',
      sql`(
        (${table.kilo_user_id} IS NOT NULL AND ${table.organization_id} IS NULL) OR
        (${table.kilo_user_id} IS NULL AND ${table.organization_id} IS NOT NULL)
      )`
    ),
  ]
);

export type BYOKApiKey = typeof byok_api_keys.$inferSelect;

// Security Reviews - Phase 1
export const security_findings = pgTable(
  'security_findings',
  {
    id: idPrimaryKeyColumn,

    // Ownership (same pattern as cloud_agent_code_reviews)
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),

    // Platform integration reference
    platform_integration_id: uuid().references(() => platform_integrations.id, {
      onDelete: 'set null',
    }),

    // Repository
    repo_full_name: text().notNull(),

    // Source identification
    source: text().notNull(), // 'dependabot' | 'pnpm_audit' | 'github_issue'
    source_id: text().notNull(), // Dependabot alert number as string

    // Severity (normalized)
    severity: text().notNull(), // 'critical' | 'high' | 'medium' | 'low'

    // Advisory info
    ghsa_id: text(),
    cve_id: text(),

    // Package info
    package_name: text().notNull(),
    package_ecosystem: text().notNull(), // 'npm' | 'pip' | 'gem' | etc.
    vulnerable_version_range: text(),
    patched_version: text(),
    manifest_path: text(),

    // Finding details
    title: text().notNull(),
    description: text(),

    // Status
    status: text().notNull().default('open'), // 'open' | 'fixed' | 'ignored'
    ignored_reason: text(),
    ignored_by: text(),
    fixed_at: timestamp({ withTimezone: true, mode: 'string' }),

    // SLA tracking
    sla_due_at: timestamp({ withTimezone: true, mode: 'string' }),

    // Dependabot-specific
    dependabot_html_url: text(),

    // Additional metadata from source (denormalized for queries)
    cwe_ids: text().array(), // CWE classification (e.g., ['CWE-79', 'CWE-89'])
    cvss_score: decimal({ precision: 3, scale: 1 }), // CVSS score (e.g., 9.8)
    dependency_scope: text(), // 'development' | 'runtime'

    // Agent session tracking (for analysis workflow)
    session_id: text(), // Cloud agent session ID (agent_xxx)
    cli_session_id: text(), // Kilo CLI session ID (ses_xxx from cli_sessions_v2)
    analysis_status: text(), // 'pending' | 'running' | 'completed' | 'failed'
    analysis_started_at: timestamp({ withTimezone: true, mode: 'string' }),
    analysis_completed_at: timestamp({ withTimezone: true, mode: 'string' }),
    analysis_error: text(), // Error message if analysis failed

    // LLM Analysis result - populated when analysis completes
    analysis: jsonb().$type<SecurityFindingAnalysis>(),

    // Raw data for debugging/future use
    raw_data: jsonb().$type<DependabotAlertRaw>(),

    // Timestamps
    first_detected_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    last_synced_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Unique constraint to prevent duplicates
    unique('uq_security_findings_source').on(table.repo_full_name, table.source, table.source_id),
    // Indexes
    index('idx_security_findings_org_id').on(table.owned_by_organization_id),
    index('idx_security_findings_user_id').on(table.owned_by_user_id),
    index('idx_security_findings_repo').on(table.repo_full_name),
    index('idx_security_findings_severity').on(table.severity),
    index('idx_security_findings_status').on(table.status),
    index('idx_security_findings_package').on(table.package_name),
    index('idx_security_findings_sla_due_at').on(table.sla_due_at),
    // Agent session indexes
    index('idx_security_findings_session_id').on(table.session_id),
    index('idx_security_findings_cli_session_id').on(table.cli_session_id),
    index('idx_security_findings_analysis_status').on(table.analysis_status),
    index('idx_security_findings_org_analysis_in_flight')
      .on(table.owned_by_organization_id, table.analysis_status)
      .where(sql`${table.analysis_status} IN ('pending', 'running')`),
    index('idx_security_findings_user_analysis_in_flight')
      .on(table.owned_by_user_id, table.analysis_status)
      .where(sql`${table.analysis_status} IN ('pending', 'running')`),
    // Owner check constraint
    check(
      'security_findings_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
  ]
);

export type SecurityFinding = typeof security_findings.$inferSelect;
export type NewSecurityFinding = typeof security_findings.$inferInsert;

export const security_analysis_queue = pgTable(
  'security_analysis_queue',
  {
    id: idPrimaryKeyColumn,
    finding_id: uuid()
      .notNull()
      .references(() => security_findings.id, { onDelete: 'cascade' }),
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    queue_status: text().notNull(),
    severity_rank: smallint().notNull(),
    queued_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    claimed_at: timestamp({ withTimezone: true, mode: 'string' }),
    claimed_by_job_id: text(),
    claim_token: text(),
    attempt_count: integer().notNull().default(0),
    reopen_requeue_count: integer().notNull().default(0),
    next_retry_at: timestamp({ withTimezone: true, mode: 'string' }),
    failure_code: text(),
    last_error_redacted: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_security_analysis_queue_finding_id').on(table.finding_id),
    check(
      'security_analysis_queue_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
    check(
      'security_analysis_queue_status_check',
      sql`${table.queue_status} IN ('queued', 'pending', 'running', 'failed', 'completed')`
    ),
    check(
      'security_analysis_queue_claim_token_required_check',
      sql`${table.queue_status} NOT IN ('pending', 'running') OR ${table.claim_token} IS NOT NULL`
    ),
    check(
      'security_analysis_queue_attempt_count_non_negative_check',
      sql`${table.attempt_count} >= 0`
    ),
    check(
      'security_analysis_queue_reopen_requeue_count_non_negative_check',
      sql`${table.reopen_requeue_count} >= 0`
    ),
    check(
      'security_analysis_queue_severity_rank_check',
      sql`${table.severity_rank} IN (0, 1, 2, 3)`
    ),
    check(
      'security_analysis_queue_failure_code_check',
      sql`${table.failure_code} IS NULL OR ${table.failure_code} IN (
        'NETWORK_TIMEOUT',
        'UPSTREAM_5XX',
        'TEMP_TOKEN_FAILURE',
        'START_CALL_AMBIGUOUS',
        'REQUEUE_TEMPORARY_PRECONDITION',
        'ACTOR_RESOLUTION_FAILED',
        'GITHUB_TOKEN_UNAVAILABLE',
        'INVALID_CONFIG',
        'MISSING_OWNERSHIP',
        'PERMISSION_DENIED_PERMANENT',
        'UNSUPPORTED_SEVERITY',
        'INSUFFICIENT_CREDITS',
        'STATE_GUARD_REJECTED',
        'SKIPPED_ALREADY_IN_PROGRESS',
        'SKIPPED_NO_LONGER_ELIGIBLE',
        'REOPEN_LOOP_GUARD',
        'RUN_LOST'
      )`
    ),
    index('idx_security_analysis_queue_claim_path_org')
      .on(
        table.owned_by_organization_id,
        sql`coalesce(${table.next_retry_at}, '-infinity'::timestamptz)`,
        table.severity_rank,
        table.queued_at,
        table.id
      )
      .where(sql`${table.queue_status} = 'queued'`),
    index('idx_security_analysis_queue_claim_path_user')
      .on(
        table.owned_by_user_id,
        sql`coalesce(${table.next_retry_at}, '-infinity'::timestamptz)`,
        table.severity_rank,
        table.queued_at,
        table.id
      )
      .where(sql`${table.queue_status} = 'queued'`),
    index('idx_security_analysis_queue_in_flight_org')
      .on(table.owned_by_organization_id, table.queue_status, table.claimed_at, table.id)
      .where(sql`${table.queue_status} IN ('pending', 'running')`),
    index('idx_security_analysis_queue_in_flight_user')
      .on(table.owned_by_user_id, table.queue_status, table.claimed_at, table.id)
      .where(sql`${table.queue_status} IN ('pending', 'running')`),
    index('idx_security_analysis_queue_lag_dashboards')
      .on(table.queued_at)
      .where(sql`${table.queue_status} = 'queued'`),
    index('idx_security_analysis_queue_pending_reconciliation')
      .on(table.claimed_at, table.id)
      .where(sql`${table.queue_status} = 'pending'`),
    index('idx_security_analysis_queue_running_reconciliation')
      .on(table.updated_at, table.id)
      .where(sql`${table.queue_status} = 'running'`),
    index('idx_security_analysis_queue_failure_trend')
      .on(table.failure_code, table.updated_at)
      .where(sql`${table.failure_code} IS NOT NULL`),
  ]
);

export type SecurityAnalysisQueue = typeof security_analysis_queue.$inferSelect;
export type NewSecurityAnalysisQueue = typeof security_analysis_queue.$inferInsert;

export const security_analysis_owner_state = pgTable(
  'security_analysis_owner_state',
  {
    id: idPrimaryKeyColumn,
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    auto_analysis_enabled_at: timestamp({ withTimezone: true, mode: 'string' }),
    blocked_until: timestamp({ withTimezone: true, mode: 'string' }),
    block_reason: text(),
    consecutive_actor_resolution_failures: integer().notNull().default(0),
    last_actor_resolution_failure_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    check(
      'security_analysis_owner_state_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
    check(
      'security_analysis_owner_state_block_reason_check',
      sql`${table.block_reason} IS NULL OR ${table.block_reason} IN ('INSUFFICIENT_CREDITS', 'ACTOR_RESOLUTION_FAILED', 'OPERATOR_PAUSE')`
    ),
    uniqueIndex('UQ_security_analysis_owner_state_org_owner')
      .on(table.owned_by_organization_id)
      .where(isNotNull(table.owned_by_organization_id)),
    uniqueIndex('UQ_security_analysis_owner_state_user_owner')
      .on(table.owned_by_user_id)
      .where(isNotNull(table.owned_by_user_id)),
  ]
);

export type SecurityAnalysisOwnerState = typeof security_analysis_owner_state.$inferSelect;

// Security Audit Log — SOC2-compliant audit trail for security agent actions
export const security_audit_log = pgTable(
  'security_audit_log',
  {
    id: idPrimaryKeyColumn,
    // XOR ownership: exactly one of owned_by_organization_id or owned_by_user_id must be set.
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    // actor_id is text to match kilocode_users.id; nullable for system-initiated actions
    actor_id: text(),
    actor_email: text(),
    actor_name: text(),
    action: text().$type<SecurityAuditLogAction>().notNull(),
    resource_type: text().notNull(),
    resource_id: text().notNull(),
    before_state: jsonb().$type<Record<string, unknown>>(),
    after_state: jsonb().$type<Record<string, unknown>>(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    check(
      'security_audit_log_owner_check',
      sql`(${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)`
    ),
    enumCheck('security_audit_log_action_check', table.action, SecurityAuditLogAction),
    index('IDX_security_audit_log_org_created').on(
      table.owned_by_organization_id,
      table.created_at
    ),
    index('IDX_security_audit_log_user_created').on(table.owned_by_user_id, table.created_at),
    index('IDX_security_audit_log_resource').on(table.resource_type, table.resource_id),
    index('IDX_security_audit_log_actor').on(table.actor_id, table.created_at),
    index('IDX_security_audit_log_action').on(table.action, table.created_at),
  ]
);

export type SecurityAuditLogEntry = typeof security_audit_log.$inferSelect;

// Slack Bot Request Logs - for admin debugging and statistics
export type SlackBotEventType = 'app_mention' | 'message';
export type SlackBotRequestStatus = 'success' | 'error';

export const slack_bot_requests = pgTable(
  'slack_bot_requests',
  {
    id: idPrimaryKeyColumn,

    // Ownership (from the platform_integration)
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),

    // Platform integration reference
    platform_integration_id: uuid().references(() => platform_integrations.id, {
      onDelete: 'set null',
    }),

    // Slack identifiers
    slack_team_id: text().notNull(),
    slack_team_name: text(),
    slack_channel_id: text().notNull(),
    slack_user_id: text().notNull(),
    slack_thread_ts: text(),

    // Event info
    event_type: text().notNull().$type<SlackBotEventType>(),

    // Request details
    user_message: text().notNull(),
    user_message_truncated: text(), // First 200 chars for display

    // Response details
    status: text().notNull().$type<SlackBotRequestStatus>(),
    error_message: text(),
    response_time_ms: integer(),

    // Model and tool usage
    model_used: text(),
    tool_calls_made: text().array(), // e.g., ['spawn_cloud_agent']

    // Cloud Agent session (if spawned)
    cloud_agent_session_id: text(),

    // Timestamps
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    // Indexes for admin queries
    index('idx_slack_bot_requests_created_at').on(table.created_at),
    index('idx_slack_bot_requests_slack_team_id').on(table.slack_team_id),
    index('idx_slack_bot_requests_owned_by_org_id').on(table.owned_by_organization_id),
    index('idx_slack_bot_requests_owned_by_user_id').on(table.owned_by_user_id),
    index('idx_slack_bot_requests_status').on(table.status),
    index('idx_slack_bot_requests_event_type').on(table.event_type),
    // Composite index for daily stats queries
    index('idx_slack_bot_requests_team_created').on(table.slack_team_id, table.created_at),
    // Owner check constraint (exactly one must be set, or both null for orphaned records)
    check(
      'slack_bot_requests_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NULL)
      )`
    ),
  ]
);

export type SlackBotRequest = typeof slack_bot_requests.$inferSelect;
export type NewSlackBotRequest = typeof slack_bot_requests.$inferInsert;

// Auto Triage
export const auto_triage_tickets = pgTable(
  'auto_triage_tickets',
  {
    id: idPrimaryKeyColumn,

    // Ownership (exactly one must be set)
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),

    // Platform integration
    platform_integration_id: uuid().references(() => platform_integrations.id, {
      onDelete: 'set null',
    }),

    // GitHub metadata
    platform: text().notNull().default('github'),
    repo_full_name: text().notNull(),
    issue_number: integer().notNull(),
    issue_url: text().notNull(),
    issue_title: text().notNull(),
    issue_body: text(),
    issue_author: text().notNull(),
    issue_type: text().notNull().$type<'issue' | 'pull_request'>(),
    issue_labels: text()
      .array()
      .default(sql`'{}'`),

    // Classification results
    classification: text().$type<'bug' | 'feature' | 'question' | 'duplicate' | 'unclear'>(),
    confidence: decimal({ precision: 3, scale: 2 }),
    intent_summary: text(),
    related_files: text().array(),

    // Duplicate detection
    is_duplicate: boolean().default(false),
    duplicate_of_ticket_id: uuid().references((): AnyPgColumn => auto_triage_tickets.id),
    similarity_score: decimal({ precision: 3, scale: 2 }),
    qdrant_point_id: text(), // MD5 hash

    // Triage session
    session_id: text(),

    // Auto Fix trigger
    should_auto_fix: boolean().default(false),

    // Status
    status: text()
      .notNull()
      .default('pending')
      .$type<'pending' | 'analyzing' | 'actioned' | 'failed' | 'skipped'>(),
    action_taken: text().$type<
      'pr_created' | 'comment_posted' | 'closed_duplicate' | 'needs_clarification'
    >(),
    action_metadata: jsonb(),
    error_message: text(),

    // Timestamps
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    completed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Unique index on repo and issue number
    uniqueIndex('UQ_auto_triage_tickets_repo_issue').on(table.repo_full_name, table.issue_number),
    // Indexes for ownership lookups
    index('IDX_auto_triage_tickets_owned_by_org').on(table.owned_by_organization_id),
    index('IDX_auto_triage_tickets_owned_by_user').on(table.owned_by_user_id),
    // Indexes for status and filtering
    index('IDX_auto_triage_tickets_status').on(table.status),
    index('IDX_auto_triage_tickets_created_at').on(table.created_at),
    index('IDX_auto_triage_tickets_qdrant_point_id').on(table.qdrant_point_id),
    // Composite indexes for common query patterns
    index('IDX_auto_triage_tickets_owner_status_created').on(
      table.owned_by_organization_id,
      table.status,
      table.created_at
    ),
    index('IDX_auto_triage_tickets_user_status_created').on(
      table.owned_by_user_id,
      table.status,
      table.created_at
    ),
    index('IDX_auto_triage_tickets_repo_classification').on(
      table.repo_full_name,
      table.classification,
      table.created_at
    ),
    // Owner check constraint (exactly one must be set)
    check(
      'auto_triage_tickets_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
    // CHECK constraints for enums and ranges
    check(
      'auto_triage_tickets_issue_type_check',
      sql`${table.issue_type} IN ('issue', 'pull_request')`
    ),
    check(
      'auto_triage_tickets_classification_check',
      sql`${table.classification} IN ('bug', 'feature', 'question', 'duplicate', 'unclear')`
    ),
    check(
      'auto_triage_tickets_confidence_check',
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`
    ),
    check(
      'auto_triage_tickets_similarity_score_check',
      sql`${table.similarity_score} >= 0 AND ${table.similarity_score} <= 1`
    ),
    check(
      'auto_triage_tickets_status_check',
      sql`${table.status} IN ('pending', 'analyzing', 'actioned', 'failed', 'skipped')`
    ),
    check(
      'auto_triage_tickets_action_taken_check',
      sql`${table.action_taken} IN ('pr_created', 'comment_posted', 'closed_duplicate', 'needs_clarification')`
    ),
  ]
);

export type AutoTriageTicket = typeof auto_triage_tickets.$inferSelect;

// Auto Fix
export const auto_fix_tickets = pgTable(
  'auto_fix_tickets',
  {
    id: idPrimaryKeyColumn,

    // Ownership (exactly one must be set)
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),

    // Platform integration
    platform_integration_id: uuid().references(() => platform_integrations.id, {
      onDelete: 'set null',
    }),

    // Link to triage ticket (optional)
    triage_ticket_id: uuid().references(() => auto_triage_tickets.id, { onDelete: 'set null' }),

    // GitHub metadata
    platform: text().notNull().default('github'),
    repo_full_name: text().notNull(),
    issue_number: integer().notNull(),
    issue_url: text().notNull(),
    issue_title: text().notNull(),
    issue_body: text(),
    issue_author: text().notNull(),
    issue_labels: text()
      .array()
      .default(sql`'{}'`),

    // Trigger source: 'label' for issue label triggers, 'review_comment' for PR review comment triggers
    trigger_source: text().notNull().default('label').$type<'label' | 'review_comment'>(),

    // Review comment context (populated when trigger_source='review_comment')
    review_comment_id: bigint({ mode: 'number' }),
    review_comment_body: text(),
    file_path: text(),
    line_number: integer(),
    diff_hunk: text(),
    pr_head_ref: text(),

    // Classification from triage (denormalized for convenience)
    classification: text().$type<'bug' | 'feature' | 'question' | 'unclear'>(),
    confidence: decimal({ precision: 3, scale: 2 }),
    intent_summary: text(),
    related_files: text().array(),

    // Cloud Agent session
    session_id: text(), // Cloud agent session ID (agent_xxx)
    cli_session_id: uuid().references(() => cliSessions.session_id, { onDelete: 'set null' }),

    // PR information
    pr_number: integer(),
    pr_url: text(),
    pr_branch: text(),

    // Status
    status: text()
      .notNull()
      .default('pending')
      .$type<'pending' | 'running' | 'completed' | 'failed' | 'cancelled'>(),
    error_message: text(),

    // Timestamps
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    completed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Unique constraint: one fix per repo+issue combination (for label-triggered fixes)
    uniqueIndex('UQ_auto_fix_tickets_repo_issue')
      .on(table.repo_full_name, table.issue_number)
      .where(sql`${table.trigger_source} = 'label'`),
    // Unique constraint: one fix per repo+review_comment (for review-comment-triggered fixes)
    uniqueIndex('UQ_auto_fix_tickets_repo_review_comment')
      .on(table.repo_full_name, table.review_comment_id)
      .where(sql`${table.review_comment_id} IS NOT NULL`),
    // Indexes for ownership lookups
    index('IDX_auto_fix_tickets_owned_by_org').on(table.owned_by_organization_id),
    index('IDX_auto_fix_tickets_owned_by_user').on(table.owned_by_user_id),
    // Indexes for status and filtering
    index('IDX_auto_fix_tickets_status').on(table.status),
    index('IDX_auto_fix_tickets_created_at').on(table.created_at),
    index('IDX_auto_fix_tickets_triage_ticket_id').on(table.triage_ticket_id),
    index('IDX_auto_fix_tickets_session_id').on(table.session_id),
    // Owner check constraint (exactly one must be set)
    check(
      'auto_fix_tickets_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
    // CHECK constraints for enums and ranges
    check(
      'auto_fix_tickets_status_check',
      sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`
    ),
    check(
      'auto_fix_tickets_classification_check',
      sql`${table.classification} IN ('bug', 'feature', 'question', 'unclear')`
    ),
    check(
      'auto_fix_tickets_confidence_check',
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`
    ),
    check(
      'auto_fix_tickets_trigger_source_check',
      sql`${table.trigger_source} IN ('label', 'review_comment')`
    ),
  ]
);

export type AutoFixTicket = typeof auto_fix_tickets.$inferSelect;

// Period types for user_period_cache
export const PeriodType = ['year', 'quarter', 'month', 'week', 'custom'] as const;
export type PeriodType = (typeof PeriodType)[number];

export const user_period_cache = pgTable(
  'user_period_cache',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade' }),
    cache_type: text().notNull(), // 'wrapped', 'usage_summary', etc.
    period_type: text().notNull().$type<PeriodType>(), // 'year', 'month', etc.
    period_key: text().notNull(), // '2024', '2024-Q1', '2024-03'
    data: jsonb().notNull(),
    computed_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    version: integer().default(1).notNull(), // Data schema version for invalidation

    // Shareability
    shared_url_token: text(), // Random token like 'a8f3k2x9'
    shared_at: timestamp({ withTimezone: true, mode: 'string' }), // When sharing was enabled
  },
  table => [
    index('IDX_user_period_cache_kilo_user_id').on(table.kilo_user_id),
    uniqueIndex('UQ_user_period_cache').on(
      table.kilo_user_id,
      table.cache_type,
      table.period_type,
      table.period_key
    ),
    index('IDX_user_period_cache_lookup').on(table.cache_type, table.period_type, table.period_key),
    uniqueIndex('UQ_user_period_cache_share_token')
      .on(table.shared_url_token)
      .where(sql`${table.shared_url_token} IS NOT NULL`), // Partial unique index
    check(
      'user_period_cache_period_type_check',
      sql`${table.period_type} IN ('year', 'quarter', 'month', 'week', 'custom')`
    ),
  ]
);

export type UserPeriodCache = typeof user_period_cache.$inferSelect;

// ============ FREE MODEL USAGE (rate limiting) ============
// Lightweight table for rate limiting on free models
// IP-based for client-side products, per-user for server-side products

export const free_model_usage = pgTable(
  'free_model_usage',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    ip_address: text().notNull(),
    model: text().notNull(),
    // Optional: link to authenticated user if present (for analytics and per-user rate limiting)
    kilo_user_id: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    // Primary index for rate limiting queries
    index('idx_free_model_usage_ip_created_at').on(table.ip_address, table.created_at),
    // Secondary index for analytics
    index('idx_free_model_usage_created_at').on(table.created_at),
  ]
);

export type FreeModelUsage = typeof free_model_usage.$inferSelect;

// ============ AGENT ENVIRONMENT PROFILES ============
// Profiles for storing reusable environment configurations for cloud-agent sessions

export const agent_environment_profiles = pgTable(
  'agent_environment_profiles',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    // Ownership: exactly one must be set (org OR user) - matches platform_integrations pattern
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    created_by_user_id: text(), // Audit trail: the user who created this profile (useful for org-owned profiles)

    name: text().notNull(),
    description: text(),
    is_default: boolean().notNull().default(false), // Only one per owner via partial unique index

    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Unique name per owner
    uniqueIndex('UQ_agent_env_profiles_org_name')
      .on(table.owned_by_organization_id, table.name)
      .where(isNotNull(table.owned_by_organization_id)),
    uniqueIndex('UQ_agent_env_profiles_user_name')
      .on(table.owned_by_user_id, table.name)
      .where(isNotNull(table.owned_by_user_id)),
    // Only one default per owner (partial unique indexes)
    uniqueIndex('UQ_agent_env_profiles_org_default')
      .on(table.owned_by_organization_id)
      .where(sql`${table.is_default} = true AND ${table.owned_by_organization_id} IS NOT NULL`),
    uniqueIndex('UQ_agent_env_profiles_user_default')
      .on(table.owned_by_user_id)
      .where(sql`${table.is_default} = true AND ${table.owned_by_user_id} IS NOT NULL`),
    // Indexes
    index('IDX_agent_env_profiles_org_id').on(table.owned_by_organization_id),
    index('IDX_agent_env_profiles_user_id').on(table.owned_by_user_id),
    index('IDX_agent_env_profiles_created_by_user_id').on(table.created_by_user_id),
    // Owner check constraint (exactly one must be set)
    check(
      'agent_env_profiles_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
  ]
);

export type AgentEnvironmentProfile = typeof agent_environment_profiles.$inferSelect;

// Single table for both env vars and secrets - matches deployment_env_vars pattern
export const agent_environment_profile_vars = pgTable(
  'agent_environment_profile_vars',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    profile_id: uuid()
      .notNull()
      .references(() => agent_environment_profiles.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: text().notNull(), // Plaintext if is_secret=false, encrypted if is_secret=true
    is_secret: boolean().notNull().default(false),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_agent_env_profile_vars_profile_id').on(table.profile_id),
    unique('UQ_agent_env_profile_vars_profile_key').on(table.profile_id, table.key),
  ]
);

export type AgentEnvironmentProfileVar = typeof agent_environment_profile_vars.$inferSelect;

export const agent_environment_profile_commands = pgTable(
  'agent_environment_profile_commands',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    profile_id: uuid()
      .notNull()
      .references(() => agent_environment_profiles.id, { onDelete: 'cascade' }),
    sequence: integer().notNull(),
    command: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_agent_env_profile_commands_profile_id').on(table.profile_id),
    unique('UQ_agent_env_profile_commands_profile_sequence').on(table.profile_id, table.sequence),
  ]
);

export type AgentEnvironmentProfileCommand = typeof agent_environment_profile_commands.$inferSelect;

// ============ AGENT ENVIRONMENT PROFILE REPO BINDINGS ============
// Bind a single environment profile to a repository so sessions auto-inherit it

export const agent_environment_profile_repo_bindings = pgTable(
  'agent_environment_profile_repo_bindings',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    repo_full_name: text().notNull(),
    platform: text({ enum: ['github', 'gitlab'] })
      .notNull()
      .default('github'),
    profile_id: uuid()
      .notNull()
      .references(() => agent_environment_profiles.id, { onDelete: 'cascade' }),
    // Ownership: exactly one must be set (mirrors agent_environment_profiles pattern)
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    // One binding per repo+platform per user
    uniqueIndex('UQ_agent_env_profile_repo_bindings_user')
      .on(table.repo_full_name, table.platform, table.owned_by_user_id)
      .where(isNotNull(table.owned_by_user_id)),
    // One binding per repo+platform per org
    uniqueIndex('UQ_agent_env_profile_repo_bindings_org')
      .on(table.repo_full_name, table.platform, table.owned_by_organization_id)
      .where(isNotNull(table.owned_by_organization_id)),
    // Owner check constraint (exactly one must be set)
    check(
      'agent_env_profile_repo_bindings_owner_check',
      sql`(
        (${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR
        (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)
      )`
    ),
  ]
);

export type AgentEnvironmentProfileRepoBinding =
  typeof agent_environment_profile_repo_bindings.$inferSelect;
export type NewAgentEnvironmentProfileRepoBinding =
  typeof agent_environment_profile_repo_bindings.$inferInsert;

// ============ AGENT ENVIRONMENT PROFILE MCP SERVERS ============
// MCP servers configured on an environment profile. Materialized into the
// CLI-native KILO_CONFIG_CONTENT.mcp block at session preparation time.

export const agent_environment_profile_mcp_servers = pgTable(
  'agent_environment_profile_mcp_servers',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    profile_id: uuid()
      .notNull()
      .references(() => agent_environment_profiles.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    type: text({ enum: ['local', 'remote'] }).notNull(),
    enabled: boolean().notNull().default(true),
    timeout: integer(),
    // CLI-native MCP config as jsonb. Non-secret fields (command, args, url, env/header keys)
    // are stored as plain values. Each env/header *value* is stored as an RSA+AES envelope
    // object ({ encryptedData, encryptedDEK, algorithm, version }) using the same format as
    // agent_environment_profile_vars. Decryption happens only on the cloud-agent-next worker
    // at session preparation time.
    config: jsonb().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_agent_env_profile_mcp_servers_profile_id').on(table.profile_id),
    unique('UQ_agent_env_profile_mcp_servers_profile_name').on(table.profile_id, table.name),
  ]
);

export type AgentEnvironmentProfileMcpServer =
  typeof agent_environment_profile_mcp_servers.$inferSelect;

// ============ AGENT ENVIRONMENT PROFILE SKILLS ============
// Kilo Code skills attached to an environment profile. Materialized into
// ${SESSION_HOME}/.kilocode/skills/<name>/SKILL.md at session preparation time.

export const agent_environment_profile_skills = pgTable(
  'agent_environment_profile_skills',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    profile_id: uuid()
      .notNull()
      .references(() => agent_environment_profiles.id, { onDelete: 'cascade' }),
    // Skill slug — must match the frontmatter `name` and is used as the directory name
    name: text().notNull(),
    description: text(),
    source_type: text({ enum: ['marketplace', 'custom'] }).notNull(),
    // URL the skill was imported from (marketplace entry URL, or null for 'custom')
    source_url: text(),
    raw_markdown: text().notNull(),
    // Companion files for a multi-file skill. Map of relative path → file
    // contents (text). Excludes SKILL.md itself (lives in raw_markdown).
    // Materialized under ${sessionHome}/.kilocode/skills/<name>/<relativePath>.
    files: jsonb().$type<Record<string, string>>().notNull().default({}),
    enabled: boolean().notNull().default(true),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_agent_env_profile_skills_profile_id').on(table.profile_id),
    unique('UQ_agent_env_profile_skills_profile_name').on(table.profile_id, table.name),
  ]
);

export type AgentEnvironmentProfileSkill = typeof agent_environment_profile_skills.$inferSelect;

// ============ AGENT ENVIRONMENT PROFILE AGENTS ============
// Kilo "agents" (the modern successor to legacy custom modes) attached to an
// environment profile. Materialized into KILO_CONFIG_CONTENT.agent.<slug> at
// session preparation time; the stored `config` jsonb already matches the
// CLI's AgentConfig shape so we pass through untransformed.

export const agent_environment_profile_agents = pgTable(
  'agent_environment_profile_agents',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    profile_id: uuid()
      .notNull()
      .references(() => agent_environment_profiles.id, { onDelete: 'cascade' }),
    // Agent slug — used as KILO_CONFIG_CONTENT.agent.<slug>.
    slug: text().notNull(),
    // Display name shown in the picker.
    name: text().notNull(),
    // AgentConfig shape: prompt, description, mode, model, temperature, top_p,
    // steps, hidden, disable, color, variant, permission, options. See
    // AgentConfigSchema in schema-types.ts for the authoritative validator.
    config: jsonb().notNull().default({}),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_agent_env_profile_agents_profile_id').on(table.profile_id),
    unique('UQ_agent_env_profile_agents_profile_slug').on(table.profile_id, table.slug),
  ]
);

export type AgentEnvironmentProfileAgent = typeof agent_environment_profile_agents.$inferSelect;

// ============ AGENT ENVIRONMENT PROFILE KILO COMMANDS ============
// Custom slash commands attached to an environment profile. Materialized into
// KILO_CONFIG_CONTENT.command.<name> at session preparation time.

export const agent_environment_profile_kilo_commands = pgTable(
  'agent_environment_profile_kilo_commands',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    profile_id: uuid()
      .notNull()
      .references(() => agent_environment_profiles.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text(),
    template: text().notNull(),
    agent: text(),
    model: text(),
    subtask: boolean().notNull().default(false),
    enabled: boolean().notNull().default(true),
    sort_order: integer().notNull().default(0),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_agent_env_profile_kilo_cmds_profile_id').on(table.profile_id),
    unique('UQ_agent_env_profile_kilo_cmds_profile_name').on(table.profile_id, table.name),
  ]
);

export type AgentEnvironmentProfileKiloCommand =
  typeof agent_environment_profile_kilo_commands.$inferSelect;

// ============ APP BUILDER FEEDBACK ============

export const app_builder_feedback = pgTable(
  'app_builder_feedback',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_user_id: text().references(() => kilocode_users.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    project_id: uuid().references(() => app_builder_projects.id, {
      onDelete: 'cascade',
    }),
    session_id: text(),
    model: text(),
    preview_status: text(),
    is_streaming: boolean(),
    message_count: integer(),
    feedback_text: text().notNull(),
    recent_messages: jsonb().$type<{ role: string; text: string; ts: number }[]>(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_app_builder_feedback_created_at').on(table.created_at),
    index('IDX_app_builder_feedback_kilo_user_id').on(table.kilo_user_id),
    index('IDX_app_builder_feedback_project_id').on(table.project_id),
  ]
);

export type AppBuilderFeedback = typeof app_builder_feedback.$inferSelect;
export type NewAppBuilderFeedback = typeof app_builder_feedback.$inferInsert;

// ============ CLOUD AGENT FEEDBACK ============

export const cloud_agent_feedback = pgTable(
  'cloud_agent_feedback',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    kilo_user_id: text().references(() => kilocode_users.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    cloud_agent_session_id: text(),
    organization_id: uuid().references(() => organizations.id, {
      onDelete: 'set null',
    }),
    model: text(),
    repository: text(),
    is_streaming: boolean(),
    message_count: integer(),
    feedback_text: text().notNull(),
    recent_messages: jsonb().$type<{ role: string; text: string; ts: number }[]>(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_cloud_agent_feedback_created_at').on(table.created_at),
    index('IDX_cloud_agent_feedback_kilo_user_id').on(table.kilo_user_id),
    index('IDX_cloud_agent_feedback_cloud_agent_session_id').on(table.cloud_agent_session_id),
  ]
);

export type CloudAgentFeedback = typeof cloud_agent_feedback.$inferSelect;
export type NewCloudAgentFeedback = typeof cloud_agent_feedback.$inferInsert;

// ─── KiloClaw (multi-tenant sandbox instances) ──────────────────────

export const kiloclaw_instances = pgTable(
  'kiloclaw_instances',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id),
    sandbox_id: text().notNull(),
    provider: text().$type<KiloClawProvider>().notNull().default(KiloClawProvider.Fly),
    // Null = personal instance. Non-null = org-owned instance.
    organization_id: uuid().references(() => organizations.id),
    name: text(),
    inbound_email_enabled: boolean().default(true).notNull(),
    inactive_trial_stopped_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    destroyed_at: timestamp({ withTimezone: true, mode: 'string' }),
    // Denormalized copy of the DO's trackedImageTag, populated by the per-instance alarm
    // reconciler. Source of truth remains the DO; this column exists so admin tooling
    // can filter populations by current running version via SQL. Up to ~30min stale on
    // idle instances (matches the longest alarm interval).
    tracked_image_tag: text(),
    // Denormalized copy of the DO's instanceType. Source of truth remains the DO;
    // this column exists so admin tooling and future billing work can filter by tier.
    instance_type: text(),
    // Denormalized copy of the DO's `adminMachineSizeOverride` + metadata. Non-null
    // means the instance is currently running with admin-supplied CPU/RAM that
    // diverge from its billable tier hardware (`machineSize` / `instance_type`).
    // Source of truth is the DO; written by the worker on explicit admin
    // set/clear, plus auto-cleared as part of a tier resize.
    // Shape: { size: { cpus, memory_mb, cpu_kind? }, reason, actorId, actorEmail, setAt }.
    admin_size_override: jsonb(),
  },
  table => [
    // One active instance per user+sandbox combination.
    uniqueIndex('UQ_kiloclaw_instances_active')
      .on(table.user_id, table.sandbox_id)
      .where(isNull(table.destroyed_at)),
    index('IDX_kiloclaw_instances_active_personal_by_user')
      .on(table.user_id)
      .where(sql`${table.organization_id} IS NULL AND ${table.destroyed_at} IS NULL`),
    index('IDX_kiloclaw_instances_active_org_by_user_org')
      .on(table.user_id, table.organization_id)
      .where(sql`${table.organization_id} IS NOT NULL AND ${table.destroyed_at} IS NULL`),
    // Non-partial index over all rows (including destroyed) so we can answer
    // "what is this user's earliest instance" without a sequential scan. Used
    // by `userIsWithinFirstKiloClawInstanceWindow` on the AI gateway hot path;
    // the existing partial-by-user indexes can't serve it because they exclude
    // destroyed rows, and destroyed rows must still count for "first instance"
    // semantics.
    index('IDX_kiloclaw_instances_user_id_created_at').on(table.user_id, table.created_at),
    // Powers admin "instances on version X" filter; partial since destroyed rows are excluded.
    index('IDX_kiloclaw_instances_tracked_image_tag')
      .on(table.tracked_image_tag)
      .where(isNull(table.destroyed_at)),
    index('IDX_kiloclaw_instances_instance_type')
      .on(table.instance_type)
      .where(isNull(table.destroyed_at)),
    check(
      'CHK_kiloclaw_instances_instance_type',
      sql`${table.instance_type} IS NULL OR ${table.instance_type} IN (${sql.join(
        INSTANCE_TYPE_VALUES.map(value => sql.raw(`'${value}'`)),
        sql.raw(', ')
      )})`
    ),
    // Powers the admin "outstanding overrides" filter. Partial (active rows
    // only) so the index stays small.
    index('IDX_kiloclaw_instances_admin_size_override')
      .on(table.id)
      .where(sql`${table.admin_size_override} IS NOT NULL AND ${table.destroyed_at} IS NULL`),
  ]
);

export type KiloClawInstance = typeof kiloclaw_instances.$inferSelect;

export type KiloClawGoogleOAuthStatus = 'active' | 'action_required' | 'disconnected';
export type KiloClawGoogleOAuthCredentialProfile = 'legacy' | 'kilo_owned';
export type KiloClawGoogleOAuthGrantsBySource = {
  legacy?: string[];
  oauth?: string[];
};

export const kiloclaw_google_oauth_connections = pgTable(
  'kiloclaw_google_oauth_connections',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    instance_id: uuid()
      .notNull()
      .references(() => kiloclaw_instances.id),
    provider: text().notNull().default('google'),
    account_email: text().notNull(),
    account_subject: text().notNull(),
    oauth_client_id: text().notNull(),
    oauth_client_secret_encrypted: text(),
    credential_profile: text()
      .$type<KiloClawGoogleOAuthCredentialProfile>()
      .notNull()
      .default('kilo_owned'),
    refresh_token_encrypted: text().notNull(),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    grants_by_source: jsonb()
      .$type<KiloClawGoogleOAuthGrantsBySource>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    capabilities: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text().$type<KiloClawGoogleOAuthStatus>().notNull().default('active'),
    last_error: text(),
    last_error_at: timestamp({ withTimezone: true, mode: 'string' }),
    connected_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_kiloclaw_google_oauth_connections_instance').on(table.instance_id),
    index('IDX_kiloclaw_google_oauth_connections_status').on(table.status),
    index('IDX_kiloclaw_google_oauth_connections_provider').on(table.provider),
    check(
      'kiloclaw_google_oauth_connections_status_check',
      sql`${table.status} IN ('active', 'action_required', 'disconnected')`
    ),
    check(
      'kiloclaw_google_oauth_connections_credential_profile_check',
      sql`${table.credential_profile} IN ('legacy', 'kilo_owned')`
    ),
  ]
);

export type KiloClawGoogleOAuthConnection = typeof kiloclaw_google_oauth_connections.$inferSelect;
export type NewKiloClawGoogleOAuthConnection =
  typeof kiloclaw_google_oauth_connections.$inferInsert;

export const kiloclaw_inbound_email_reserved_aliases = pgTable(
  'kiloclaw_inbound_email_reserved_aliases',
  {
    alias: text().primaryKey().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  }
);

export type KiloClawInboundEmailReservedAlias =
  typeof kiloclaw_inbound_email_reserved_aliases.$inferSelect;
export type NewKiloClawInboundEmailReservedAlias =
  typeof kiloclaw_inbound_email_reserved_aliases.$inferInsert;

export const kiloclaw_inbound_email_aliases = pgTable(
  'kiloclaw_inbound_email_aliases',
  {
    alias: text().primaryKey().notNull(),
    instance_id: uuid()
      .notNull()
      .references(() => kiloclaw_instances.id, { onDelete: 'cascade' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    retired_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  table => [
    index('IDX_kiloclaw_inbound_email_aliases_instance_id').on(table.instance_id),
    uniqueIndex('UQ_kiloclaw_inbound_email_aliases_active_instance')
      .on(table.instance_id)
      .where(isNull(table.retired_at)),
  ]
);

export type KiloClawInboundEmailAlias = typeof kiloclaw_inbound_email_aliases.$inferSelect;
export type NewKiloClawInboundEmailAlias = typeof kiloclaw_inbound_email_aliases.$inferInsert;

// KiloClaw Morning Briefing Configuration
//
// Denormalized read cache of which instances have the morning briefing
// enabled and how it's configured (cron, timezone, interest topics). The
// briefing plugin's local `config.json` on the instance remains the source
// of truth for actual runtime behavior; this table mirrors the same
// values so external readers (admin tooling, analytics, dashboard reads)
// can answer "who has briefing enabled?" / "who picked topic X?" without
// scanning every instance gateway.
//
// Write ownership: the KiloClaw worker is the sole writer (matches
// `kiloclaw_instances` ownership). The worker pushes the same config to
// the plugin in the same request; if the Postgres write fails the
// briefing still works — the plugin has the config — the mirror is just
// stale for that instance. Plugin runtime state (cronJobId, last-generated
// timestamps, reconcile state) is NOT mirrored here.
//
// Backfill: pre-existing instances have no row here until the first
// post-deploy `getMorningBriefingStatus` call lazily writes one from the
// plugin response. Same pattern as `kiloclaw_instances.tracked_image_tag`.
// Admin queries that scan this table are "current-best-known view," not
// authoritative — per-instance gateway queries remain the ground truth.
//
// 1:1 with `kiloclaw_instances`. No surrogate id; `instance_id` is the
// natural key (compare `kiloclaw_inbound_email_aliases`, which uses `alias`
// as PK). Skips the join indirection from any future FK to this table.
// Owner / org are NOT denormalized — join through `kiloclaw_instances` if
// you need them (no precedent for denorm on the other kiloclaw_* tables).
export const kiloclaw_morning_briefing_configs = pgTable(
  'kiloclaw_morning_briefing_configs',
  {
    instance_id: uuid()
      .primaryKey()
      .notNull()
      .references(() => kiloclaw_instances.id, { onDelete: 'cascade' }),
    // Desired state. `false` means the user has not enabled briefing (or
    // has disabled it). The plugin's `observedEnabled` (in gateway status)
    // may lag during reconcile.
    enabled: boolean().default(false).notNull(),
    // Defaults match the plugin's hard-coded defaults
    // (`services/kiloclaw/plugins/kiloclaw-morning-briefing/src/index.ts`).
    // Keep these in sync if the plugin defaults ever change.
    cron: text().notNull().default('0 7 * * *'),
    timezone: text().notNull().default('UTC'),
    // Selected by the user during onboarding (PR-4b) or from settings.
    // Empty array means "no topics selected" — the plugin (PR-4c) falls
    // back to its default web-search query in that case. Column is
    // defined in PR-4a and unused until PR-4b lands. `text[]` (not jsonb)
    // matches the existing pattern in `kiloclaw_google_oauth_connections`
    // (`scopes`, `capabilities`); native array operators and GIN-indexable.
    interest_topics: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    // NOTE: `$onUpdateFn` only fires on Drizzle ORM writes. Any raw
    // `db.execute(sql\`UPDATE ...\`)` writer must set `updated_at = now()`
    // explicitly; otherwise the column will silently miss bumps.
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    // Powers the bulk admin scan "list instance_ids where briefing is
    // enabled" — partial so it stays small (only enabled rows occupy
    // it). `instance_id` is the PK so this index gives no lookup
    // benefit beyond the predicate-narrowed scan; the value is purely
    // in skipping disabled rows.
    //
    // If/when an admin query also needs `interest_topics` per row,
    // consider an INCLUDE clause (e.g.
    // `INCLUDE (interest_topics)`) so Postgres can satisfy the scan
    // index-only without heap fetches. Drizzle 0.45's PgIndexBuilder
    // doesn't expose `.include()` declaratively; it would need raw
    // SQL in the migration. Skipping for now — the table is small
    // enough that the heap fetch is cheap, and we don't have a
    // concrete admin query that reads topics in bulk yet.
    index('IDX_kiloclaw_morning_briefing_configs_enabled')
      .on(table.instance_id)
      .where(sql`${table.enabled} = true`),
  ]
);

export type KiloClawMorningBriefingConfig = typeof kiloclaw_morning_briefing_configs.$inferSelect;
export type NewKiloClawMorningBriefingConfig =
  typeof kiloclaw_morning_briefing_configs.$inferInsert;

// KiloClaw Admin Audit Log — tracks admin actions on KiloClaw instances
export const kiloclaw_admin_audit_logs = pgTable(
  'kiloclaw_admin_audit_logs',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    action: text().$type<KiloClawAdminAuditAction>().notNull(),
    actor_id: text(),
    actor_email: text(),
    actor_name: text(),
    target_user_id: text().notNull(),
    message: text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_kiloclaw_admin_audit_logs_target_user_id').on(table.target_user_id),
    index('IDX_kiloclaw_admin_audit_logs_action').on(table.action),
    index('IDX_kiloclaw_admin_audit_logs_created_at').on(table.created_at),
  ]
);

export type KiloClawAdminAuditLog = typeof kiloclaw_admin_audit_logs.$inferSelect;

// KiloClaw Access Codes — one-time codes for authenticating browser sessions to the worker
export const kiloclaw_access_codes = pgTable(
  'kiloclaw_access_codes',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    code: text().notNull(),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade' }),
    status: text().$type<'active' | 'redeemed' | 'expired'>().notNull().default('active'),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    redeemed_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('UQ_kiloclaw_access_codes_code').on(table.code),
    index('IDX_kiloclaw_access_codes_user_status').on(table.kilo_user_id, table.status),
    uniqueIndex('UQ_kiloclaw_access_codes_one_active_per_user')
      .on(table.kilo_user_id)
      .where(sql`status = 'active'`),
  ]
);

export type KiloClawAccessCode = typeof kiloclaw_access_codes.$inferSelect;

// KiloClaw Image Catalog — version registry populated by the worker via Hyperdrive on deploy.
// A version in the catalog is not necessarily available to users; status controls availability.
export const kiloclaw_image_catalog = pgTable(
  'kiloclaw_image_catalog',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    openclaw_version: text().notNull(),
    variant: text().notNull().default('default'),
    image_tag: text().notNull().unique(),
    image_digest: text(),
    status: text().$type<'available' | 'disabled'>().notNull().default('available'),
    description: text(),
    updated_by: text(),
    published_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    synced_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    // Per-image staggered rollout slider. 0 = not exposed.
    // 0 < x < 100 = staged candidate (offered to instances whose bucket falls
    // below x). Independent of `is_latest` — promoting an image to ":latest" is
    // an explicit, separate action.
    rollout_percent: integer().notNull().default(0),
    // Marks this row as the production ":latest" for its variant. New instances
    // and unpinned upgrades fall back to whichever row has this set. At most
    // one row per variant should have this true at a time (enforced in the
    // mutation layer, not by a DB constraint, so an in-flight migration can't
    // wedge the system).
    is_latest: boolean().notNull().default(false),
  },
  table => [
    index('IDX_kiloclaw_image_catalog_status').on(table.status),
    index('IDX_kiloclaw_image_catalog_variant').on(table.variant),
    // Enforce "at most one :latest per variant" at the DB layer. Without this
    // partial UNIQUE, two concurrent markImageAsLatest transactions could each
    // clear the old :latest and then set different rows to true. Matches the
    // codebase pattern for single-row-per-key invariants (see UQ_kilo_pass_*,
    // UQ_kilocode_users_* in this file).
    uniqueIndex('UQ_kiloclaw_image_catalog_one_latest_per_variant')
      .on(table.variant)
      .where(sql`${table.is_latest} = true`),
    // Enforce "at most one in-flight candidate per variant" at the DB layer.
    // The candidate is any available, non-:latest row with a non-zero rollout
    // percent. Prevents two concurrent setRolloutPercent calls from each
    // creating a candidate, which refreshPointersForVariant would otherwise
    // resolve by published_at and silently hide one from instances.
    uniqueIndex('UQ_kiloclaw_image_catalog_one_candidate_per_variant')
      .on(table.variant)
      .where(
        sql`${table.is_latest} = false AND ${table.rollout_percent} > 0 AND ${table.status} = 'available'`
      ),
  ]
);

export type KiloClawImageCatalogEntry = typeof kiloclaw_image_catalog.$inferSelect;

// Discord Gateway Listener coordination
// Single-row table that tracks the currently active Gateway listener.
// Used to ensure only one Gateway WebSocket connection is active at a time
// across multiple serverless instances. New listeners atomically claim the
// active slot, and existing listeners poll to detect they've been superseded.
export const discord_gateway_listener = pgTable('discord_gateway_listener', {
  // Singleton: always id = 1
  id: integer().primaryKey().default(1),
  // Unique identifier for the currently active listener instance
  listener_id: text().notNull(),
  // When this listener started
  started_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  // When this listener is expected to stop (started_at + duration)
  expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
});

export type DiscordGatewayListener = typeof discord_gateway_listener.$inferSelect;

// KiloClaw Version Pins — one row per instance, tracks who pinned them and why.
// Both admins and end users can pin (distinguished by pinned_by).
export const kiloclaw_version_pins = pgTable('kiloclaw_version_pins', {
  id: uuid()
    .default(sql`gen_random_uuid()`)
    .primaryKey()
    .notNull(),
  instance_id: uuid()
    .notNull()
    .references(() => kiloclaw_instances.id)
    .unique(),
  image_tag: text()
    .notNull()
    .references(() => kiloclaw_image_catalog.image_tag, { onDelete: 'restrict' }),
  pinned_by: text()
    .notNull()
    .references(() => kilocode_users.id),
  reason: text(),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export type KiloClawVersionPin = typeof kiloclaw_version_pins.$inferSelect;

// ─── Scheduled Admin Actions ───────────────────────────────────────────
//
// Generic scheduled-action framework with `action_type` discriminator.
// First action type is `scheduled_restart` (no-op redeploy at a chosen
// time). `version_change` lands in a follow-on PR. The discriminator lets
// future action types drop in without a schema rebuild.
//
// Boundary: this scheduler is kiloclaw-scoped. Other domains build their
// own. Don't extract into shared infrastructure until at least three
// domains have shipped their own implementations.

export const kiloclaw_scheduled_actions = pgTable(
  'kiloclaw_scheduled_actions',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),

    // Discriminator. PR 1 emits 'scheduled_restart'. PR 3 adds
    // 'version_change'. Future types add new values; type-specific
    // columns below stay nullable so unrelated types ignore them.
    action_type: text().$type<'scheduled_restart' | 'version_change'>().notNull(),

    // version_change-specific fields. Nullable; ignored by other action
    // types. Live on the parent for v1 (one populated type at a time);
    // migrate to a JSON payload column or sibling table if a future
    // action type has very different fields.
    target_image_tag: text().references(() => kiloclaw_image_catalog.image_tag, {
      onDelete: 'restrict',
    }),
    override_pins: boolean().notNull().default(false),

    // Notice config. Populated for any action type that triggers user
    // notification in PR 2+; PR 1 leaves these as empty strings since
    // scheduled_restart in PR 1 doesn't notify.
    notice_lead_hours: integer().notNull().default(24), // 0..168
    notice_subject: text().notNull().default(''),
    notice_body: text().notNull().default(''),

    reason: text(), // optional admin-facing label

    status: text().$type<KiloClawScheduledActionStatus>().notNull().default('scheduled'),

    created_by: text()
      .notNull()
      .references(() => kilocode_users.id),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    completed_at: timestamp({ withTimezone: true, mode: 'string' }),
    cancelled_at: timestamp({ withTimezone: true, mode: 'string' }),

    total_count: integer().notNull().default(0),
    applied_count: integer().notNull().default(0),
    skipped_count: integer().notNull().default(0),
    failed_count: integer().notNull().default(0),
  },
  table => [
    index('IDX_kiloclaw_scheduled_actions_status').on(table.status),
    index('IDX_kiloclaw_scheduled_actions_action_type').on(table.action_type),
    index('IDX_kiloclaw_scheduled_actions_created_by').on(table.created_by),
  ]
);

export type KiloClawScheduledAction = typeof kiloclaw_scheduled_actions.$inferSelect;
export type NewKiloClawScheduledAction = typeof kiloclaw_scheduled_actions.$inferInsert;

export const kiloclaw_scheduled_action_stages = pgTable(
  'kiloclaw_scheduled_action_stages',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    scheduled_action_id: uuid()
      .notNull()
      .references(() => kiloclaw_scheduled_actions.id, { onDelete: 'cascade' }),

    stage_index: integer().notNull(), // 0-based per parent
    scheduled_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),

    status: text().$type<KiloClawScheduledActionStageStatus>().notNull().default('pending'),

    notice_sent_at: timestamp({ withTimezone: true, mode: 'string' }),
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    completed_at: timestamp({ withTimezone: true, mode: 'string' }),

    applied_count: integer().notNull().default(0),
    skipped_count: integer().notNull().default(0),
    failed_count: integer().notNull().default(0),
  },
  table => [
    uniqueIndex('UQ_kiloclaw_scheduled_action_stages_parent_index').on(
      table.scheduled_action_id,
      table.stage_index
    ),
    // Notice-tick lookup (used in PR 2): stages whose notice window has
    // opened. Partial index for cheap sweep.
    index('IDX_kiloclaw_scheduled_action_stages_notice_due')
      .on(table.scheduled_at)
      .where(sql`${table.notice_sent_at} IS NULL AND ${table.status} = 'pending'`),
  ]
);

export type KiloClawScheduledActionStage = typeof kiloclaw_scheduled_action_stages.$inferSelect;
export type NewKiloClawScheduledActionStage = typeof kiloclaw_scheduled_action_stages.$inferInsert;

export const kiloclaw_scheduled_action_targets = pgTable(
  'kiloclaw_scheduled_action_targets',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    scheduled_action_id: uuid()
      .notNull()
      .references(() => kiloclaw_scheduled_actions.id, { onDelete: 'cascade' }),
    stage_id: uuid().references(() => kiloclaw_scheduled_action_stages.id, {
      onDelete: 'set null',
    }),
    instance_id: uuid()
      .notNull()
      .references(() => kiloclaw_instances.id, { onDelete: 'cascade' }),

    // Captured at schedule time so a deleted catalog row can't lose
    // history. Informational only in v1 (no rollback).
    source_image_tag: text(),
    target_image_tag: text(), // null for non-version-change action types

    user_id: text()
      .notNull()
      .references(() => kilocode_users.id),

    applied_at: timestamp({ withTimezone: true, mode: 'string' }),

    // 'running' is a transient claim state set by the DO apply path
    // immediately before it dispatches the side effect (restartMachine).
    // Without it, two concurrent waitUntil passes can both find the
    // same pending row and both fire the side effect — only one wins
    // the final CAS but both restarts have already been kicked off.
    // The claim CAS (pending → running) makes the dispatch
    // single-writer without needing a row lock.
    status: text().$type<KiloClawScheduledActionTargetStatus>().notNull().default('pending'),
    skip_reason: text(),
    error_message: text(),
  },
  table => [
    uniqueIndex('UQ_kiloclaw_scheduled_action_targets_parent_instance').on(
      table.scheduled_action_id,
      table.instance_id
    ),
    index('IDX_kiloclaw_scheduled_action_targets_stage').on(table.stage_id),
    // DO apply path lookup: pending targets for an instance whose stage
    // has fired. Partial index keeps the lookup cheap on large fleets.
    index('IDX_kiloclaw_scheduled_action_targets_pending_by_instance')
      .on(table.instance_id)
      .where(sql`${table.status} = 'pending'`),
  ]
);

export type KiloClawScheduledActionTarget = typeof kiloclaw_scheduled_action_targets.$inferSelect;
export type NewKiloClawScheduledActionTarget =
  typeof kiloclaw_scheduled_action_targets.$inferInsert;

// Per-target, per-channel notification rows. Channels dispatch and
// persist independently — knowing email succeeded but mobile push
// failed matters for retry and debug. Adding a new channel later is a
// new value in the enum, not a schema change.
//
// kind='notice' is the heads-up dispatched ahead of the scheduled time;
// kind='cancelled' is the follow-up emitted when an admin cancels the
// action AFTER a notice was already sent for that (target, channel).
// We never insert a 'cancelled' row for a (target, channel) that has
// no prior sent 'notice' — surfacing a cancellation to a user who
// never got the original heads-up would be confusing.
export const kiloclaw_scheduled_action_notifications = pgTable(
  'kiloclaw_scheduled_action_notifications',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    target_id: uuid()
      .notNull()
      .references(() => kiloclaw_scheduled_action_targets.id, { onDelete: 'cascade' }),

    channel: text().$type<KiloClawScheduledActionNotificationChannel>().notNull(),

    kind: text().$type<KiloClawScheduledActionNotificationKind>().notNull().default('notice'),

    status: text().$type<KiloClawScheduledActionNotificationStatus>().notNull().default('pending'),

    // Set when the sweep CAS-claims the row (pending → sending). Used
    // by the next tick to detect and recover stuck claims left behind
    // by a sweep that crashed mid-dispatch.
    claimed_at: timestamp({ withTimezone: true, mode: 'string' }),
    sent_at: timestamp({ withTimezone: true, mode: 'string' }),
    error_message: text(),
  },
  table => [
    // One notification per (target, kind, channel). A target may have
    // both kinds (notice sent, then cancellation queued).
    uniqueIndex('UQ_kiloclaw_scheduled_action_notifications_target_kind_channel').on(
      table.target_id,
      table.kind,
      table.channel
    ),
    // Sweep lookup: notifications still pending dispatch. The partial
    // predicate keeps the index small (only pending rows). Keyed on
    // target_id so the sweep's join into kiloclaw_scheduled_action_targets
    // can use it for the inner-join lookup. Point lookups by id (markSent,
    // markFailed) hit the primary key index directly.
    index('IDX_kiloclaw_scheduled_action_notifications_pending')
      .on(table.target_id)
      .where(sql`${table.status} = 'pending'`),
  ]
);

export type KiloClawScheduledActionNotification =
  typeof kiloclaw_scheduled_action_notifications.$inferSelect;
export type NewKiloClawScheduledActionNotification =
  typeof kiloclaw_scheduled_action_notifications.$inferInsert;

// KiloClaw Early Bird Purchases — records one-time earlybird payments.
// Unique on user_id enforces at most one purchase per user.
// Unique on stripe_charge_id provides webhook idempotency.
export const kiloclaw_earlybird_purchases = pgTable('kiloclaw_earlybird_purchases', {
  id: uuid()
    .default(sql`gen_random_uuid()`)
    .primaryKey()
    .notNull(),
  user_id: text()
    .notNull()
    .references(() => kilocode_users.id)
    .unique(),
  stripe_charge_id: text().unique(),
  manual_payment_id: text().unique(),
  amount_cents: integer().notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export type KiloClawEarlybirdPurchase = typeof kiloclaw_earlybird_purchases.$inferSelect;

export const kiloclaw_subscriptions = pgTable(
  'kiloclaw_subscriptions',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id),
    stripe_subscription_id: text().unique(),
    stripe_schedule_id: text(),
    transferred_to_subscription_id: uuid().references((): AnyPgColumn => kiloclaw_subscriptions.id),
    instance_id: uuid().references(() => kiloclaw_instances.id),
    access_origin: text().$type<KiloClawSubscriptionAccessOrigin>(),
    payment_source: text().$type<KiloClawPaymentSource>(),
    kiloclaw_price_version: text()
      .notNull()
      .$type<KiloClawPriceVersion>()
      .$defaultFn((): KiloClawPriceVersion => {
        throw new Error('kiloclaw_price_version must be set explicitly by subscription writers');
      }),
    plan: text().notNull().$type<KiloClawPlan>(),
    scheduled_plan: text().$type<KiloClawScheduledPlan>(),
    scheduled_by: text().$type<KiloClawScheduledBy>(),
    status: text().notNull().$type<KiloClawSubscriptionStatus>(),
    cancel_at_period_end: boolean().notNull().default(false),
    pending_conversion: boolean().notNull().default(false),
    trial_started_at: timestamp({ withTimezone: true, mode: 'string' }),
    trial_ends_at: timestamp({ withTimezone: true, mode: 'string' }),
    current_period_start: timestamp({ withTimezone: true, mode: 'string' }),
    current_period_end: timestamp({ withTimezone: true, mode: 'string' }),
    credit_renewal_at: timestamp({ withTimezone: true, mode: 'string' }),
    commit_ends_at: timestamp({ withTimezone: true, mode: 'string' }),
    past_due_since: timestamp({ withTimezone: true, mode: 'string' }),
    suspended_at: timestamp({ withTimezone: true, mode: 'string' }),
    destruction_deadline: timestamp({ withTimezone: true, mode: 'string' }),
    auto_resume_requested_at: timestamp({ withTimezone: true, mode: 'string' }),
    auto_resume_retry_after: timestamp({ withTimezone: true, mode: 'string' }),
    auto_resume_attempt_count: integer().notNull().default(0),
    auto_top_up_triggered_for_period: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_kiloclaw_subscriptions_status').on(table.status),
    index('IDX_kiloclaw_subscriptions_user_id').on(table.user_id),
    index('IDX_kiloclaw_subscriptions_user_status').on(table.user_id, table.status),
    index('IDX_kiloclaw_subscriptions_price_version').on(table.kiloclaw_price_version),
    index('IDX_kiloclaw_subscriptions_transferred_to').on(table.transferred_to_subscription_id),
    index('IDX_kiloclaw_subscriptions_stripe_schedule_id').on(table.stripe_schedule_id),
    index('IDX_kiloclaw_subscriptions_auto_resume_retry_after').on(table.auto_resume_retry_after),
    check(
      'kiloclaw_subscriptions_price_version_check',
      sql`${table.kiloclaw_price_version} IN (${sql.join(
        KILOCLAW_PRICE_VERSIONS.map(version => sql.raw(`'${version}'`)),
        sql.raw(', ')
      )})`
    ),
    enumCheck('kiloclaw_subscriptions_plan_check', table.plan, KiloClawPlan),
    enumCheck(
      'kiloclaw_subscriptions_scheduled_plan_check',
      table.scheduled_plan,
      KiloClawScheduledPlan
    ),
    enumCheck('kiloclaw_subscriptions_scheduled_by_check', table.scheduled_by, KiloClawScheduledBy),
    enumCheck('kiloclaw_subscriptions_status_check', table.status, KiloClawSubscriptionStatus),
    enumCheck(
      'kiloclaw_subscriptions_access_origin_check',
      table.access_origin,
      KiloClawSubscriptionAccessOrigin
    ),
    uniqueIndex('UQ_kiloclaw_subscriptions_instance')
      .on(table.instance_id)
      .where(isNotNull(table.instance_id)),
    uniqueIndex('UQ_kiloclaw_subscriptions_transferred_to')
      .on(table.transferred_to_subscription_id)
      .where(isNotNull(table.transferred_to_subscription_id)),
    index('IDX_kiloclaw_subscriptions_earlybird_origin')
      .on(table.user_id, table.access_origin)
      .where(sql`${table.access_origin} = 'earlybird'`),
    enumCheck(
      'kiloclaw_subscriptions_payment_source_check',
      table.payment_source,
      KiloClawPaymentSource
    ),
  ]
);

export type KiloClawSubscription = typeof kiloclaw_subscriptions.$inferSelect;
export type NewKiloClawSubscription = typeof kiloclaw_subscriptions.$inferInsert;

export const kiloclaw_subscription_change_log = pgTable(
  'kiloclaw_subscription_change_log',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    subscription_id: uuid()
      .notNull()
      .references(() => kiloclaw_subscriptions.id),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    actor_type: text().notNull().$type<KiloClawSubscriptionChangeActorType>(),
    actor_id: text().notNull(),
    action: text().notNull().$type<KiloClawSubscriptionChangeAction>(),
    reason: text(),
    before_state: jsonb().$type<Record<string, unknown> | null>(),
    after_state: jsonb().$type<Record<string, unknown> | null>(),
  },
  table => [
    index('IDX_kiloclaw_subscription_change_log_subscription_created_at').on(
      table.subscription_id,
      table.created_at
    ),
    index('IDX_kiloclaw_subscription_change_log_created_at').on(table.created_at),
    enumCheck(
      'kiloclaw_subscription_change_log_actor_type_check',
      table.actor_type,
      KiloClawSubscriptionChangeActorType
    ),
    enumCheck(
      'kiloclaw_subscription_change_log_action_check',
      table.action,
      KiloClawSubscriptionChangeAction
    ),
  ]
);

export type KiloClawSubscriptionChangeLog = typeof kiloclaw_subscription_change_log.$inferSelect;
export type NewKiloClawSubscriptionChangeLog = typeof kiloclaw_subscription_change_log.$inferInsert;

// KiloClaw credit-renewal terminal failures — durable record of
// (subscription_id, renewal_boundary) pairs whose automatic retry has been
// exhausted and that require operator resolution, waiver, retry, or
// supersession before downstream enforcement may proceed.
//
// Only unresolved rows protect a subscription-renewal boundary from
// downstream enforcement. Resolved, waived, and superseded rows are kept for
// operator history but do not block enforcement.
//
// Uniqueness on (subscription_id, renewal_boundary) makes duplicate
// terminal-failure recording for the same boundary idempotent: ON CONFLICT
// updates the existing row's attempt history and last-error fields rather
// than inserting a duplicate.
export const kiloclaw_terminal_renewal_failures = pgTable(
  'kiloclaw_terminal_renewal_failures',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    subscription_id: uuid()
      .notNull()
      .references(() => kiloclaw_subscriptions.id),
    renewal_boundary: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    status: text()
      .notNull()
      .$type<KiloClawTerminalRenewalFailureStatus>()
      .default(KiloClawTerminalRenewalFailureStatus.Unresolved),
    attempt_count: integer().notNull().default(0),
    first_failure_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    last_failure_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    last_failure_code: text().notNull().$type<KiloClawTerminalRenewalFailureCode>(),
    last_failure_message: text(),
    resolution_actor_type: text().$type<KiloClawTerminalRenewalFailureResolutionActorType>(),
    resolution_actor_id: text(),
    resolution_at: timestamp({ withTimezone: true, mode: 'string' }),
    resolution_reason: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_kiloclaw_terminal_renewal_failures_subscription_boundary').on(
      table.subscription_id,
      table.renewal_boundary
    ),
    // Partial index optimizing the hot enforcement-protection lookup and
    // operator diagnostics for unresolved failures only. Resolved, waived,
    // and superseded rows are kept for history but are not in the index.
    index('IDX_kiloclaw_terminal_renewal_failures_unresolved')
      .on(table.subscription_id, table.renewal_boundary)
      .where(sql`${table.status} = 'unresolved'`),
    index('IDX_kiloclaw_terminal_renewal_failures_status_last_failure_at').on(
      table.status,
      table.last_failure_at
    ),
    enumCheck(
      'kiloclaw_terminal_renewal_failures_status_check',
      table.status,
      KiloClawTerminalRenewalFailureStatus
    ),
    enumCheck(
      'kiloclaw_terminal_renewal_failures_last_failure_code_check',
      table.last_failure_code,
      KiloClawTerminalRenewalFailureCode
    ),
    enumCheck(
      'kiloclaw_terminal_renewal_failures_resolution_actor_type_check',
      table.resolution_actor_type,
      KiloClawTerminalRenewalFailureResolutionActorType
    ),
  ]
);

export type KiloClawTerminalRenewalFailure = typeof kiloclaw_terminal_renewal_failures.$inferSelect;
export type NewKiloClawTerminalRenewalFailure =
  typeof kiloclaw_terminal_renewal_failures.$inferInsert;

// KiloClaw subscription-started emails are per paid activation, not per
// instance lifetime. Cancel+resubscribe reuses the same subscription row (we
// UPDATE the existing row in place), so only `period_start` — which advances
// on every fresh activation — distinguishes activation events. `period_start`
// defaults to the Unix epoch so the unique-index math works for any future
// per-instance email type that has no natural per-activation boundary: those
// callers pass no value and collapse to one row per (user, instance, type).
export const kiloclaw_email_log = pgTable(
  'kiloclaw_email_log',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id),
    instance_id: uuid().references(() => kiloclaw_instances.id),
    email_type: text().notNull(),
    period_start: timestamp({ withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'epoch'`),
    sent_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('UQ_kiloclaw_email_log_user_type_global')
      .on(table.user_id, table.email_type)
      .where(isNull(table.instance_id)),
    uniqueIndex('UQ_kiloclaw_email_log_user_instance_type_period')
      .on(table.user_id, table.instance_id, table.email_type, table.period_start)
      .where(isNotNull(table.instance_id)),
    index('IDX_kiloclaw_email_log_type_sent_instance')
      .on(table.email_type, table.sent_at, table.instance_id, table.user_id)
      .where(isNotNull(table.instance_id)),
  ]
);

export type KiloClawEmailLog = typeof kiloclaw_email_log.$inferSelect;

// Outbox marker for transactional emails that need durable idempotency beyond
// their triggering side effect. For top-up confirmations, `processTopUp`
// commits the credit_transactions row before firing the email via `after()`;
// if the process exits between those steps, a webhook retry can observe that
// the transactional email marker is missing and recover the email exactly once.
export const transactional_email_log = pgTable(
  'transactional_email_log',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text().references(() => kilocode_users.id),
    organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    email_type: text().notNull(),
    idempotency_key: text().notNull(),
    sent_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    uniqueIndex('UQ_transactional_email_log_type_idempotency_key').on(
      table.email_type,
      table.idempotency_key
    ),
    index('IDX_transactional_email_log_user_id').on(table.user_id),
    index('IDX_transactional_email_log_organization_id').on(table.organization_id),
    check(
      'CHK_transactional_email_log_owner',
      sql`${table.user_id} IS NOT NULL OR ${table.organization_id} IS NOT NULL`
    ),
  ]
);

export type TransactionalEmailLog = typeof transactional_email_log.$inferSelect;

// Bot Request Logs — tracks each message handled by the new bot (src/lib/bot.ts).
// Rows are created as 'pending' on receipt and updated as processing progresses.
export type BotRequestStatus = 'pending' | 'completed' | 'error';

export type BotRequestStep = {
  stepNumber: number;
  finishReason: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  toolResults?: Array<{ name: string; result: unknown }>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export const bot_requests = pgTable(
  'bot_requests',
  {
    id: idPrimaryKeyColumn,

    created_by: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade' }),
    organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),

    platform_integration_id: uuid().references(() => platform_integrations.id, {
      onDelete: 'set null',
    }),

    platform: text().notNull(),
    platform_thread_id: text().notNull(),
    platform_message_id: text().notNull(),

    user_message: text().notNull(),

    status: text().notNull().$type<BotRequestStatus>().default('pending'),
    error_message: text(),
    model_used: text(),

    steps: jsonb().$type<BotRequestStep[]>(),

    cloud_agent_session_id: text(),
    response_time_ms: integer(),

    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    index('IDX_bot_requests_created_at').on(table.created_at),
    index('IDX_bot_requests_created_by').on(table.created_by),
    index('IDX_bot_requests_organization_id').on(table.organization_id),
    index('IDX_bot_requests_platform_integration_id').on(table.platform_integration_id),
    index('IDX_bot_requests_status').on(table.status),
  ]
);

export type BotRequest = typeof bot_requests.$inferSelect;

export const app_min_versions = pgTable('app_min_versions', {
  id: uuid()
    .default(sql`pg_catalog.gen_random_uuid()`)
    .primaryKey()
    .notNull(),
  ios_min_version: text().notNull().default('1.0.0'),
  android_min_version: text().notNull().default('1.0.0'),
  updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export type AppMinVersions = typeof app_min_versions.$inferSelect;
export type NewBotRequest = typeof bot_requests.$inferInsert;

// ─── Bot Request Cloud Agent Sessions ───────────────────────────────

export type BotRequestCloudAgentSessionStatus =
  | 'prepared'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export const bot_request_cloud_agent_sessions = pgTable(
  'bot_request_cloud_agent_sessions',
  {
    id: idPrimaryKeyColumn,

    bot_request_id: uuid()
      .notNull()
      .references(() => bot_requests.id, { onDelete: 'cascade' }),

    spawn_group_id: uuid(),

    cloud_agent_session_id: text().notNull(),
    kilo_session_id: text(),
    execution_id: text(),

    status: text().notNull().$type<BotRequestCloudAgentSessionStatus>().default('running'),

    mode: text().$type<'code' | 'ask'>(),

    github_repo: text(),
    gitlab_project: text(),

    callback_step: integer().notNull().default(0),
    error_message: text(),
    final_message: text(),
    final_message_fetched_at: timestamp({ withTimezone: true, mode: 'string' }),
    final_message_error: text(),

    terminal_at: timestamp({ withTimezone: true, mode: 'string' }),
    continuation_started_at: timestamp({ withTimezone: true, mode: 'string' }),

    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_bot_request_cas_cloud_agent_session_id').on(table.cloud_agent_session_id),
    index('IDX_bot_request_cas_bot_request_id').on(table.bot_request_id),
    index('IDX_bot_request_cas_bot_request_id_spawn_group_id').on(
      table.bot_request_id,
      table.spawn_group_id
    ),
    index('IDX_bot_request_cas_bot_request_id_spawn_group_id_status').on(
      table.bot_request_id,
      table.spawn_group_id,
      table.status
    ),
  ]
);

export type BotRequestCloudAgentSession = typeof bot_request_cloud_agent_sessions.$inferSelect;
export type NewBotRequestCloudAgentSession = typeof bot_request_cloud_agent_sessions.$inferInsert;

// ─── KiloClaw CLI Runs ──────────────────────────────────────────────

export type KiloClawCliRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export const kiloclaw_cli_runs = pgTable(
  'kiloclaw_cli_runs',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade' }),
    instance_id: uuid().references(() => kiloclaw_instances.id),
    initiated_by_admin_id: text().references(() => kilocode_users.id, { onDelete: 'set null' }),
    prompt: text().notNull(),
    status: text().$type<KiloClawCliRunStatus>().notNull().default('running'),
    exit_code: integer(),
    output: text(),
    started_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    completed_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  table => [
    index('IDX_kiloclaw_cli_runs_user_id').on(table.user_id),
    index('IDX_kiloclaw_cli_runs_started_at').on(table.started_at),
    index('IDX_kiloclaw_cli_runs_instance_id').on(table.instance_id),
  ]
);

export type KiloClawCliRun = typeof kiloclaw_cli_runs.$inferSelect;
export type NewKiloClawCliRun = typeof kiloclaw_cli_runs.$inferInsert;

// ─── Push Notification Tokens ────────────────────────────────────────

export const user_push_tokens = pgTable(
  'user_push_tokens',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade' }),
    token: text().notNull(),
    platform: text().$type<'ios' | 'android'>().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    uniqueIndex('UQ_user_push_tokens_token').on(table.token),
    index('IDX_user_push_tokens_user_id').on(table.user_id),
  ]
);

export type UserPushToken = typeof user_push_tokens.$inferSelect;
export type NewUserPushToken = typeof user_push_tokens.$inferInsert;

// ============ EXA USAGE TRACKING ============
// Pre-aggregated monthly counter (hot path) + per-request audit log (partitioned)

export const exa_monthly_usage = pgTable(
  'exa_monthly_usage',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    kilo_user_id: text().notNull(),
    organization_id: uuid(),
    month: date({ mode: 'string' }).notNull(),
    total_cost_microdollars: bigint({ mode: 'number' }).notNull().default(0),
    total_charged_microdollars: bigint({ mode: 'number' }).notNull().default(0),
    request_count: integer().notNull().default(0),
    free_allowance_microdollars: bigint({ mode: 'number' }).notNull().default(10_000_000),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    // Personal usage: one row per user per month (no org)
    uniqueIndex('idx_exa_monthly_usage_personal')
      .on(table.kilo_user_id, table.month)
      .where(isNull(table.organization_id)),
    // Org usage: one row per user per org per month
    uniqueIndex('idx_exa_monthly_usage_org')
      .on(table.kilo_user_id, table.organization_id, table.month)
      .where(isNotNull(table.organization_id)),
  ]
);

export type ExaMonthlyUsage = typeof exa_monthly_usage.$inferSelect;

// Per-request audit log — partitioned by month on created_at.
// The Drizzle definition is for type inference; the actual table is created
// as a partitioned table in the migration with hand-written SQL.
export const exa_usage_log = pgTable(
  'exa_usage_log',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`),
    kilo_user_id: text().notNull(),
    organization_id: uuid(),
    path: text().notNull(),
    cost_microdollars: bigint({ mode: 'number' }).notNull(),
    charged_to_balance: boolean().notNull().default(false),
    feature_id: text(),
    type: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    primaryKey({ columns: [table.id, table.created_at] }),
    index('idx_exa_usage_log_user_created').on(table.kilo_user_id, table.created_at),
  ]
);

export type ExaUsageLog = typeof exa_usage_log.$inferSelect;

// ============ SECURITY ADVISOR SCANS ============
// Per-scan usage tracking for the security advisor feature.
// Serves as both a rate-limiting table (COUNT in 24h window) and a usage/analytics ledger.

export const security_advisor_scans = pgTable(
  'security_advisor_scans',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    kilo_user_id: text().notNull(),
    organization_id: text(),
    source_platform: text().notNull(), // 'openclaw' | 'kiloclaw'
    source_method: text().notNull(), // 'plugin' | 'api' | 'webhook' | 'cloud-agent'
    plugin_version: text(),
    openclaw_version: text(),
    public_ip: text(), // Client-reported public IP (validated as IP format). Metadata only, not used for rate limiting.
    // Audit result counts for analytics
    findings_critical: integer().notNull().default(0),
    findings_warn: integer().notNull().default(0),
    findings_info: integer().notNull().default(0),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    // Primary index for rate-limiting queries (user + time window)
    index('idx_security_advisor_scans_user_created_at').on(table.kilo_user_id, table.created_at),
    // Analytics: scans over time
    index('idx_security_advisor_scans_created_at').on(table.created_at),
    // Analytics: scans by source platform
    index('idx_security_advisor_scans_platform').on(table.source_platform),
  ]
);

export type SecurityAdvisorScan = typeof security_advisor_scans.$inferSelect;

// ============ SECURITY ADVISOR CONTENT ============
// Customer-visible report content for the security advisor feature.
// Three tables are read together by a TTL-cached content loader and injected
// into the report generator so copy changes (check descriptions, KiloClaw
// coverage blurbs, CTA copy) do not require a code deploy. Edited via the
// admin UI under /admin/kiloclaw?tab=shell-security-content. Rows can be
// soft-disabled via is_active.
//
// Note on `updated_at`: `.$onUpdateFn(() => sql\`now()\`)` only fires on
// `db.update()` calls — NOT on the SET clause of `INSERT ... ON CONFLICT
// DO UPDATE`. All writes in the admin router go through `onConflictDoUpdate`
// and explicitly set `updated_at: nowIso()`. The $onUpdateFn here is a
// safety net for any future direct `.update()` call we might add.

export const security_advisor_check_catalog = pgTable(
  'security_advisor_check_catalog',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    check_id: text().notNull().unique(),
    severity: text().notNull(), // 'critical' | 'warn' | 'info' — server-authoritative override
    explanation: text().notNull(),
    risk: text().notNull(),
    is_active: boolean().notNull().default(true),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    check(
      'security_advisor_check_catalog_severity_check',
      sql`${table.severity} in ('critical', 'warn', 'info')`
    ),
  ]
);

export type SecurityAdvisorCheck = typeof security_advisor_check_catalog.$inferSelect;
export type NewSecurityAdvisorCheck = typeof security_advisor_check_catalog.$inferInsert;

export const security_advisor_kiloclaw_coverage = pgTable('security_advisor_kiloclaw_coverage', {
  id: uuid()
    .notNull()
    .default(sql`pg_catalog.gen_random_uuid()`)
    .primaryKey(),
  area: text().notNull().unique(),
  summary: text().notNull(),
  detail: text().notNull(),
  match_check_ids: text()
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  is_active: boolean().notNull().default(true),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => sql`now()`),
});

export type SecurityAdvisorKiloClawCoverage =
  typeof security_advisor_kiloclaw_coverage.$inferSelect;
export type NewSecurityAdvisorKiloClawCoverage =
  typeof security_advisor_kiloclaw_coverage.$inferInsert;

export const security_advisor_content = pgTable('security_advisor_content', {
  id: uuid()
    .notNull()
    .default(sql`pg_catalog.gen_random_uuid()`)
    .primaryKey(),
  key: text().notNull().unique(),
  value: text().notNull(),
  description: text().notNull().default(''),
  is_active: boolean().notNull().default(true),
  created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => sql`now()`),
});

export type SecurityAdvisorContent = typeof security_advisor_content.$inferSelect;
export type NewSecurityAdvisorContent = typeof security_advisor_content.$inferInsert;

export type NewSecurityAdvisorScan = typeof security_advisor_scans.$inferInsert;

// ---------------------------------------------------------------------------
// Model experiments (preview/experimental A/B testing)
//
// Scope: opt-in dedicated preview public model ids only. Never used for
// production/general traffic. Users only reach this routing path by
// explicitly selecting a dedicated preview public id (e.g.
// `kilo/preview-experiment-foo`).
// ---------------------------------------------------------------------------

export const model_experiment = pgTable(
  'model_experiment',
  {
    id: idPrimaryKeyColumn,
    public_model_id: text().notNull(),
    name: text().notNull(),
    description: text(),
    // status: draft | active | paused | completed
    status: text().notNull().default('draft'),
    is_archived: boolean().notNull().default(false),
    created_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'set null' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
    started_at: timestamp({ withTimezone: true, mode: 'string' }),
    ended_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  table => [
    // Only one routing-relevant experiment per public_model_id at a time.
    uniqueIndex('UQ_model_experiment_public_model_id_routing')
      .on(table.public_model_id)
      .where(sql`${table.status} IN ('active', 'paused')`),
    index('IDX_model_experiment_status').on(table.status),
    check(
      'model_experiment_status_valid',
      sql`${table.status} IN ('draft', 'active', 'paused', 'completed')`
    ),
    // Active experiments cannot be archived.
    check(
      'model_experiment_active_not_archived',
      sql`${table.status} <> 'active' OR ${table.is_archived} = false`
    ),
  ]
);

export type ModelExperiment = typeof model_experiment.$inferSelect;
export type NewModelExperiment = typeof model_experiment.$inferInsert;

export const model_experiment_variant = pgTable(
  'model_experiment_variant',
  {
    id: idPrimaryKeyColumn,
    experiment_id: uuid()
      .notNull()
      .references(() => model_experiment.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    weight: integer().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => sql`now()`),
  },
  table => [
    unique('UQ_model_experiment_variant_experiment_label').on(table.experiment_id, table.label),
    index('IDX_model_experiment_variant_experiment_id').on(table.experiment_id),
    check('model_experiment_variant_weight_positive', sql`${table.weight} > 0`),
  ]
);

export type ModelExperimentVariant = typeof model_experiment_variant.$inferSelect;
export type NewModelExperimentVariant = typeof model_experiment_variant.$inferInsert;

// Immutable per-variant version. New RC = new row. Never UPDATEd.
// `upstream` is validated by ExperimentUpstreamSchema in app code. The
// api key is stored separately in `encrypted_api_key` (same shape as
// `byok_api_keys.encrypted_api_key`) so the JSONB blob never holds the
// secret and reporting/admin views can simply omit the column.
export const model_experiment_variant_version = pgTable(
  'model_experiment_variant_version',
  {
    id: idPrimaryKeyColumn,
    variant_id: uuid()
      .notNull()
      .references(() => model_experiment_variant.id, { onDelete: 'cascade' }),
    upstream: jsonb().notNull(),
    encrypted_api_key: jsonb().$type<EncryptedData>().notNull(),
    effective_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    created_by: text().references(() => kilocode_users.id, { onDelete: 'set null' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_model_experiment_variant_version_variant_effective').on(
      table.variant_id,
      table.effective_at.desc()
    ),
  ]
);

export type ModelExperimentVariantVersion = typeof model_experiment_variant_version.$inferSelect;
export type NewModelExperimentVariantVersion = typeof model_experiment_variant_version.$inferInsert;

// One row per experimented request, keyed on usage_id (1:1 with microdollar_usage).
// Stores attribution + a single R2 prompt hash for the post-`transformRequest`
// upstream body. `request_body_sha256` holds either a 64-char lowercase hex
// digest pointing at an R2 object, or one of the reserved sentinels:
// `__failed__` (R2 storage failed) or `__deleted__` (prompt content wiped
// while retaining attribution). `request_kind` records which upstream API
// shape the body was serialized for.
export const model_experiment_request = pgTable(
  'model_experiment_request',
  {
    usage_id: uuid()
      .primaryKey()
      .notNull()
      .references(() => microdollar_usage.id, { onDelete: 'cascade' }),
    variant_version_id: uuid()
      .notNull()
      .references(() => model_experiment_variant_version.id),
    // 'user' | 'machine' | 'ip'
    allocation_subject: text().notNull(),
    client_request_id: text(),
    // 'chat_completions' | 'messages' | 'responses'
    request_kind: text().notNull(),
    // 64-char lowercase hex sha256, or '__failed__' | '__deleted__'.
    request_body_sha256: text().notNull(),
    was_truncated: boolean().notNull().default(false),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    index('IDX_model_experiment_request_variant_version_created_at').on(
      table.variant_version_id,
      table.created_at
    ),
    index('IDX_model_experiment_request_client_request_id')
      .on(table.client_request_id)
      .where(isNotNull(table.client_request_id)),
    check(
      'model_experiment_request_allocation_subject_valid',
      sql`${table.allocation_subject} IN ('user', 'machine', 'ip')`
    ),
    check(
      'model_experiment_request_request_kind_valid',
      sql`${table.request_kind} IN ('chat_completions', 'messages', 'responses')`
    ),
    check(
      'model_experiment_request_request_body_sha256_format',
      sql`${table.request_body_sha256} ~ '^[0-9a-f]{64}$' OR ${table.request_body_sha256} IN ('__failed__', '__deleted__')`
    ),
  ]
);

export type ModelExperimentRequest = typeof model_experiment_request.$inferSelect;
export type NewModelExperimentRequest = typeof model_experiment_request.$inferInsert;
