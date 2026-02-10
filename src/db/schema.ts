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
import type {
  OrganizationModeConfig,
  OrganizationPlan,
  OrganizationRole,
  OrganizationSettings,
} from '@/lib/organizations/organization-base-types';
import type { AuditLogAction } from '@/lib/organizations/audit-log-actions';
import type { EncryptedData } from '@/lib/byok/encryption';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';
import type { AbuseClassification } from '@/types/AbuseClassification';
import type { PlatformRepository, IntegrationPermissions } from '@/lib/integrations/core/types';
import type { BuildStatus, Provider } from '@/lib/user-deployments/types';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import type { DependabotAlertRaw, SecurityFindingAnalysis } from '@/lib/security-agent/core/types';
import type {
  NormalizedOpenRouterResponse,
  OpenRouterModel,
} from '@/lib/providers/openrouter/openrouter-types';
import { CliSessionSharedState } from '@/types/cli-session-shared-state';
import type Stripe from 'stripe';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassScheduledChangeStatus,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import type { AnyPgColumn as DrizzleAnyPgColumn } from 'drizzle-orm/pg-core';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { KiloClawInstanceStatus } from '@/lib/kiloclaw/enums';

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
  KiloPassIssuanceSource,
  KiloPassIssuanceItemKind,
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassScheduledChangeStatus,
  CliSessionSharedState,
  KiloClawInstanceStatus,
} as const;

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
    api_token_pepper: text(),
    auto_top_up_enabled: boolean().default(false).notNull(),
    is_bot: boolean().default(false).notNull(),
    default_model: text(),
    cohorts: jsonb().$type<Record<string, number>>().default({}).notNull(),
  },
  table => [
    unique('UQ_b1afacbcf43f2c7c4cb9f7e7faa').on(table.google_user_email),
    // Prevent empty strings
    check('blocked_reason_not_empty', sql`length(blocked_reason) > 0`),
  ]
);

export type User = typeof kilocode_users.$inferSelect;

export const kilo_pass_subscriptions = pgTable(
  'kilo_pass_subscriptions',
  {
    id: uuid()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    kilo_user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    stripe_subscription_id: text().notNull().unique(),
    tier: text().notNull().$type<KiloPassTier>(),
    cadence: text().notNull().$type<KiloPassCadence>(),
    status: text().notNull().$type<Stripe.Subscription.Status>(),
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
    index('IDX_kilo_pass_subscriptions_status').on(table.status),
    index('IDX_kilo_pass_subscriptions_cadence').on(table.cadence),
    check(
      'kilo_pass_subscriptions_current_streak_months_non_negative_check',
      sql`${table.current_streak_months} >= 0`
    ),
    enumCheck('kilo_pass_subscriptions_tier_check', table.tier, KiloPassTier),
    enumCheck('kilo_pass_subscriptions_cadence_check', table.cadence, KiloPassCadence),
  ]
);

export type KiloPassSubscription = typeof kilo_pass_subscriptions.$inferSelect;
export type NewKiloPassSubscription = typeof kilo_pass_subscriptions.$inferInsert;

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
    has_tools: boolean(),
  },
  table => [index('idx_microdollar_usage_metadata_created_at').on(table.created_at)]
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
  has_tools: boolean(),
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
    meta.has_tools
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
`);

export type MicrodollarUsageView = typeof microdollar_usage_view.$inferSelect;

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
    index('idx_fingerprint_data').on(table.fingerprint_data),
    index('idx_hardware_fingerprint').on(table.hardware_fingerprint),
    index('idx_kilo_user_id').on(table.kilo_user_id),
    index('idx_reasons').on(table.reasons),
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
    microdollars_balance: bigint({ mode: 'number' })
      .default(sql`'0'`)
      .notNull(),
    microdollars_used: bigint({ mode: 'number' })
      .default(sql`'0'`)
      .notNull(),
    stripe_customer_id: text(),
    auto_top_up_enabled: boolean().default(false).notNull(),
    settings: jsonb().default({}).$type<OrganizationSettings>().notNull(),
    seat_count: integer().default(0).notNull(),
    require_seats: boolean().default(false).notNull(),
    created_by_kilo_user_id: text(),
    deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
    sso_domain: text(),
    plan: text().$type<OrganizationPlan>().notNull().default('teams'),
    free_trial_end_at: timestamp({ withTimezone: true, mode: 'string' }),
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

type SubscriptionStatus = 'active' | 'pending_cancel' | 'ended';
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
    index('IDX_code_indexing_manifest_file_hash').on(table.file_hash),
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
    github_repo: text('github_repo').notNull(),
    is_active: boolean('is_active').notNull().default(true),
    // Profile reference - resolved at runtime in the worker via Hyperdrive
    // ON DELETE RESTRICT prevents deletion of profiles referenced by triggers
    profile_id: uuid('profile_id')
      .notNull()
      .references(() => agent_environment_profiles.id, {
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

export const modelsByProvider = pgTable('models_by_provider', {
  id: serial().notNull().primaryKey(),
  data: jsonb('data').$type<NormalizedOpenRouterResponse>().notNull(),
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

    // Cloud agent session
    session_id: text(), // Cloud agent session ID (agent_xxx)
    cli_session_id: uuid().references(() => cliSessions.session_id, { onDelete: 'set null' }), // CLI session UUID (from session_created event)

    // Review status
    status: text().notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
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
  ]
);

export type CliSessionV2 = typeof cli_sessions_v2.$inferSelect;
export type NewCliSessionV2 = typeof cli_sessions_v2.$inferInsert;

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
    cli_session_id: uuid().references(() => cliSessions.session_id, { onDelete: 'set null' }), // CLI session UUID
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
    // Unique constraint: one fix per repo+issue combination
    uniqueIndex('UQ_auto_fix_tickets_repo_issue').on(table.repo_full_name, table.issue_number),
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

// ============ FREE MODEL USAGE (IP-based rate limiting) ============
// Lightweight table for IP-based rate limiting on free models
// Applies to both anonymous and authenticated users

export const free_model_usage = pgTable(
  'free_model_usage',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    ip_address: text().notNull(),
    model: text().notNull(),
    // Optional: link to authenticated user if present (for analytics only)
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

// ─── KiloClaw (multi-tenant sandbox instances) ──────────────────────

export { KiloClawInstanceStatus } from '@/lib/kiloclaw/enums';

export const kiloclaw_instances = pgTable(
  'kiloclaw_instances',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    user_id: text()
      .notNull()
      .references(() => kilocode_users.id, { onDelete: 'cascade' }),
    sandbox_id: text().notNull(),
    status: text()
      .$type<KiloClawInstanceStatus>()
      .notNull()
      .default(KiloClawInstanceStatus.Provisioned),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    last_started_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_stopped_at: timestamp({ withTimezone: true, mode: 'string' }),
    destroyed_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  table => [
    // One active (non-destroyed) instance per user.
    // Re-provisioning after destroy creates a new row; old row stays with destroyed_at set.
    uniqueIndex('UQ_kiloclaw_instances_active_user')
      .on(table.user_id)
      .where(isNull(table.destroyed_at)),
    // Lookup by sandbox_id for lifecycle hooks (onStop -> find userId by sandboxId).
    index('IDX_kiloclaw_instances_sandbox_id')
      .on(table.sandbox_id)
      .where(isNull(table.destroyed_at)),
    enumCheck('kiloclaw_instances_status_check', table.status, KiloClawInstanceStatus),
  ]
);

export type KiloClawInstance = typeof kiloclaw_instances.$inferSelect;
