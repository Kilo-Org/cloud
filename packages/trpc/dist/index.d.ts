// Auto-generated — do not edit. Rebuild with: pnpm --filter @kilocode/trpc run build
import * as drizzle_orm from 'drizzle-orm';
import * as drizzle_orm_pg_core from 'drizzle-orm/pg-core';
import * as _trpc_server from '@trpc/server';
export { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import * as z from 'zod';
import { SecretFieldKey } from '@kilocode/kiloclaw-secret-catalog';
import * as _workos_inc_node from '@workos-inc/node';
import * as stripe from 'stripe';

type ChangelogCategory = 'feature' | 'bugfix';
type ChangelogDeployHint = 'redeploy_suggested' | 'redeploy_required' | 'upgrade_required' | null;
type ChangelogEntry = {
    date: string;
    description: string;
    category: ChangelogCategory;
    deployHint: ChangelogDeployHint;
};

declare enum KiloPassTier {
    Tier19 = "tier_19",
    Tier49 = "tier_49",
    Tier199 = "tier_199"
}
declare enum KiloPassCadence {
    Monthly = "monthly",
    Yearly = "yearly"
}
declare enum KiloPassIssuanceItemKind {
    Base = "base",
    Bonus = "bonus",
    PromoFirstMonth50Pct = "promo_first_month_50pct"
}
/** Matches Stripe.SubscriptionSchedule.Status */
declare enum KiloPassScheduledChangeStatus {
    NotStarted = "not_started",
    Active = "active",
    Completed = "completed",
    Released = "released",
    Canceled = "canceled"
}
declare enum CliSessionSharedState {
    Public = "public",
    Organization = "organization"
}
/**
 * Actions logged in the security_audit_log table.
 *
 * Follows a consistent 3-segment `security.entity.verb` pattern.
 */
declare enum SecurityAuditLogAction {
    FindingCreated = "security.finding.created",
    FindingStatusChange = "security.finding.status_change",
    FindingDismissed = "security.finding.dismissed",
    FindingAutoDismissed = "security.finding.auto_dismissed",
    FindingAnalysisStarted = "security.finding.analysis_started",
    FindingAnalysisCompleted = "security.finding.analysis_completed",
    FindingDeleted = "security.finding.deleted",
    ConfigEnabled = "security.config.enabled",
    ConfigDisabled = "security.config.disabled",
    ConfigUpdated = "security.config.updated",
    SyncTriggered = "security.sync.triggered",
    SyncCompleted = "security.sync.completed",
    AuditLogExported = "security.audit_log.exported"
}
declare const KiloClawPlan: {
    readonly Trial: "trial";
    readonly Commit: "commit";
    readonly Standard: "standard";
};
type KiloClawPlan = (typeof KiloClawPlan)[keyof typeof KiloClawPlan];
declare const KiloClawScheduledPlan: {
    readonly Commit: "commit";
    readonly Standard: "standard";
};
type KiloClawScheduledPlan = (typeof KiloClawScheduledPlan)[keyof typeof KiloClawScheduledPlan];
declare const KiloClawScheduledBy: {
    readonly Auto: "auto";
    readonly User: "user";
};
type KiloClawScheduledBy = (typeof KiloClawScheduledBy)[keyof typeof KiloClawScheduledBy];
declare const KiloClawSubscriptionStatus: {
    readonly Trialing: "trialing";
    readonly Active: "active";
    readonly PastDue: "past_due";
    readonly Canceled: "canceled";
    readonly Unpaid: "unpaid";
};
type KiloClawSubscriptionStatus = (typeof KiloClawSubscriptionStatus)[keyof typeof KiloClawSubscriptionStatus];
type OrganizationRole = 'owner' | 'member' | 'billing_manager';
declare const OrganizationPlanSchema: z.ZodEnum<{
    teams: "teams";
    enterprise: "enterprise";
}>;
type OrganizationPlan = z.infer<typeof OrganizationPlanSchema>;
type AuthProviderId = 'email' | 'google' | 'github' | 'gitlab' | 'linkedin' | 'discord' | 'fake-login' | 'workos';
type IntegrationPermissions = Record<string, string>;
type PlatformRepository = {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
};
declare const buildStatusSchema: z.ZodEnum<{
    failed: "failed";
    queued: "queued";
    building: "building";
    deploying: "deploying";
    deployed: "deployed";
    cancelled: "cancelled";
}>;
type BuildStatus = z.infer<typeof buildStatusSchema>;
declare const DependabotAlertState: {
    readonly OPEN: "open";
    readonly FIXED: "fixed";
    readonly DISMISSED: "dismissed";
    readonly AUTO_DISMISSED: "auto_dismissed";
};
type DependabotAlertState = (typeof DependabotAlertState)[keyof typeof DependabotAlertState];
declare const SecuritySeverity: {
    readonly CRITICAL: "critical";
    readonly HIGH: "high";
    readonly MEDIUM: "medium";
    readonly LOW: "low";
};
type SecuritySeverity = (typeof SecuritySeverity)[keyof typeof SecuritySeverity];
type DependabotAlertRaw = {
    number: number;
    state: DependabotAlertState;
    dependency: {
        package: {
            ecosystem: string;
            name: string;
        };
        manifest_path: string;
        scope: 'development' | 'runtime' | null;
    };
    security_advisory: {
        ghsa_id: string;
        cve_id: string | null;
        summary: string;
        description: string;
        severity: SecuritySeverity;
        cvss?: {
            score: number;
            vector_string: string;
        };
        cwes?: Array<{
            cwe_id: string;
            name: string;
        }>;
    };
    security_vulnerability: {
        vulnerable_version_range: string;
        first_patched_version?: {
            identifier: string;
        };
    };
    created_at: string;
    updated_at: string;
    fixed_at: string | null;
    dismissed_at: string | null;
    dismissed_by?: {
        login: string;
    } | null;
    dismissed_reason?: string | null;
    dismissed_comment?: string | null;
    auto_dismissed_at?: string | null;
    html_url: string;
    url: string;
};
type SecurityFindingTriage = {
    needsSandboxAnalysis: boolean;
    needsSandboxReasoning: string;
    suggestedAction: 'dismiss' | 'analyze_codebase' | 'manual_review';
    confidence: 'high' | 'medium' | 'low';
    triageAt: string;
};
declare const SandboxSuggestedAction: {
    readonly DISMISS: "dismiss";
    readonly OPEN_PR: "open_pr";
    readonly MANUAL_REVIEW: "manual_review";
    readonly MONITOR: "monitor";
};
type SandboxSuggestedAction = (typeof SandboxSuggestedAction)[keyof typeof SandboxSuggestedAction];
type SecurityFindingSandboxAnalysis = {
    isExploitable: boolean | 'unknown';
    exploitabilityReasoning: string;
    usageLocations: string[];
    suggestedFix: string;
    suggestedAction: SandboxSuggestedAction;
    summary: string;
    rawMarkdown: string;
    analysisAt: string;
    modelUsed?: string;
};
type SecurityFindingAnalysis = {
    triage?: SecurityFindingTriage;
    sandboxAnalysis?: SecurityFindingSandboxAnalysis;
    rawMarkdown?: string;
    analyzedAt: string;
    modelUsed?: string;
    triageModel?: string;
    analysisModel?: string;
    triggeredByUserId?: string;
    correlationId?: string;
};

/**
 * When adding or removing PII/account-linked columns, update
 * softDeleteUser() in src/lib/user.ts (and src/lib/user.test.ts) to
 * null or reset the field.
 */
declare const kilocode_users: drizzle_orm_pg_core.PgTableWithColumns<{
    name: "kilocode_users";
    schema: undefined;
    columns: {
        id: drizzle_orm_pg_core.PgColumn<{
            name: "id";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        google_user_email: drizzle_orm_pg_core.PgColumn<{
            name: "google_user_email";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        google_user_name: drizzle_orm_pg_core.PgColumn<{
            name: "google_user_name";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        google_user_image_url: drizzle_orm_pg_core.PgColumn<{
            name: "google_user_image_url";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        created_at: drizzle_orm_pg_core.PgColumn<{
            name: "created_at";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updated_at: drizzle_orm_pg_core.PgColumn<{
            name: "updated_at";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        hosted_domain: drizzle_orm_pg_core.PgColumn<{
            name: "hosted_domain";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        microdollars_used: drizzle_orm_pg_core.PgColumn<{
            name: "microdollars_used";
            tableName: "kilocode_users";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        kilo_pass_threshold: drizzle_orm_pg_core.PgColumn<{
            name: "kilo_pass_threshold";
            tableName: "kilocode_users";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        stripe_customer_id: drizzle_orm_pg_core.PgColumn<{
            name: "stripe_customer_id";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        is_admin: drizzle_orm_pg_core.PgColumn<{
            name: "is_admin";
            tableName: "kilocode_users";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        total_microdollars_acquired: drizzle_orm_pg_core.PgColumn<{
            name: "total_microdollars_acquired";
            tableName: "kilocode_users";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        next_credit_expiration_at: drizzle_orm_pg_core.PgColumn<{
            name: "next_credit_expiration_at";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        has_validation_stytch: drizzle_orm_pg_core.PgColumn<{
            name: "has_validation_stytch";
            tableName: "kilocode_users";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        has_validation_novel_card_with_hold: drizzle_orm_pg_core.PgColumn<{
            name: "has_validation_novel_card_with_hold";
            tableName: "kilocode_users";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        blocked_reason: drizzle_orm_pg_core.PgColumn<{
            name: "blocked_reason";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        api_token_pepper: drizzle_orm_pg_core.PgColumn<{
            name: "api_token_pepper";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        auto_top_up_enabled: drizzle_orm_pg_core.PgColumn<{
            name: "auto_top_up_enabled";
            tableName: "kilocode_users";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        is_bot: drizzle_orm_pg_core.PgColumn<{
            name: "is_bot";
            tableName: "kilocode_users";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        default_model: drizzle_orm_pg_core.PgColumn<{
            name: "default_model";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        cohorts: drizzle_orm_pg_core.PgColumn<{
            name: "cohorts";
            tableName: "kilocode_users";
            dataType: "json";
            columnType: "PgJsonb";
            data: Record<string, number>;
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: Record<string, number>;
        }>;
        completed_welcome_form: drizzle_orm_pg_core.PgColumn<{
            name: "completed_welcome_form";
            tableName: "kilocode_users";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        linkedin_url: drizzle_orm_pg_core.PgColumn<{
            name: "linkedin_url";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        github_url: drizzle_orm_pg_core.PgColumn<{
            name: "github_url";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        discord_server_membership_verified_at: drizzle_orm_pg_core.PgColumn<{
            name: "discord_server_membership_verified_at";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        openrouter_upstream_safety_identifier: drizzle_orm_pg_core.PgColumn<{
            name: "openrouter_upstream_safety_identifier";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        customer_source: drizzle_orm_pg_core.PgColumn<{
            name: "customer_source";
            tableName: "kilocode_users";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
type User = typeof kilocode_users.$inferSelect;
declare const organizations: drizzle_orm_pg_core.PgTableWithColumns<{
    name: "organizations";
    schema: undefined;
    columns: {
        id: drizzle_orm_pg_core.PgColumn<{
            name: "id";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        name: drizzle_orm_pg_core.PgColumn<{
            name: "name";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        created_at: drizzle_orm_pg_core.PgColumn<{
            name: "created_at";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updated_at: drizzle_orm_pg_core.PgColumn<{
            name: "updated_at";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        microdollars_used: drizzle_orm_pg_core.PgColumn<{
            name: "microdollars_used";
            tableName: "organizations";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        microdollars_balance: drizzle_orm_pg_core.PgColumn<{
            name: "microdollars_balance";
            tableName: "organizations";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        total_microdollars_acquired: drizzle_orm_pg_core.PgColumn<{
            name: "total_microdollars_acquired";
            tableName: "organizations";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        next_credit_expiration_at: drizzle_orm_pg_core.PgColumn<{
            name: "next_credit_expiration_at";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        stripe_customer_id: drizzle_orm_pg_core.PgColumn<{
            name: "stripe_customer_id";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        auto_top_up_enabled: drizzle_orm_pg_core.PgColumn<{
            name: "auto_top_up_enabled";
            tableName: "organizations";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        settings: drizzle_orm_pg_core.PgColumn<{
            name: "settings";
            tableName: "organizations";
            dataType: "json";
            columnType: "PgJsonb";
            data: {
                model_allow_list?: string[] | undefined;
                provider_allow_list?: string[] | undefined;
                model_deny_list?: string[] | undefined;
                provider_deny_list?: string[] | undefined;
                default_model?: string | undefined;
                data_collection?: "allow" | "deny" | null | undefined;
                enable_usage_limits?: boolean | undefined;
                code_indexing_enabled?: boolean | undefined;
                projects_ui_enabled?: boolean | undefined;
                minimum_balance?: number | undefined;
                minimum_balance_alert_email?: string[] | undefined;
                suppress_trial_messaging?: boolean | undefined;
                oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                github_app_type?: "standard" | "lite" | null | undefined;
                oss_monthly_credit_amount_microdollars?: number | null | undefined;
                oss_credits_last_reset_at?: string | null | undefined;
                oss_github_url?: string | null | undefined;
            };
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: {
                model_allow_list?: string[] | undefined;
                provider_allow_list?: string[] | undefined;
                model_deny_list?: string[] | undefined;
                provider_deny_list?: string[] | undefined;
                default_model?: string | undefined;
                data_collection?: "allow" | "deny" | null | undefined;
                enable_usage_limits?: boolean | undefined;
                code_indexing_enabled?: boolean | undefined;
                projects_ui_enabled?: boolean | undefined;
                minimum_balance?: number | undefined;
                minimum_balance_alert_email?: string[] | undefined;
                suppress_trial_messaging?: boolean | undefined;
                oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                github_app_type?: "standard" | "lite" | null | undefined;
                oss_monthly_credit_amount_microdollars?: number | null | undefined;
                oss_credits_last_reset_at?: string | null | undefined;
                oss_github_url?: string | null | undefined;
            };
        }>;
        seat_count: drizzle_orm_pg_core.PgColumn<{
            name: "seat_count";
            tableName: "organizations";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        require_seats: drizzle_orm_pg_core.PgColumn<{
            name: "require_seats";
            tableName: "organizations";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        created_by_kilo_user_id: drizzle_orm_pg_core.PgColumn<{
            name: "created_by_kilo_user_id";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        deleted_at: drizzle_orm_pg_core.PgColumn<{
            name: "deleted_at";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sso_domain: drizzle_orm_pg_core.PgColumn<{
            name: "sso_domain";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        plan: drizzle_orm_pg_core.PgColumn<{
            name: "plan";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgText";
            data: "teams" | "enterprise";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: "teams" | "enterprise";
        }>;
        free_trial_end_at: drizzle_orm_pg_core.PgColumn<{
            name: "free_trial_end_at";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        company_domain: drizzle_orm_pg_core.PgColumn<{
            name: "company_domain";
            tableName: "organizations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
type Organization = typeof organizations.$inferSelect;
type BillingCycle = 'monthly' | 'yearly';
declare const cloud_agent_code_reviews: drizzle_orm_pg_core.PgTableWithColumns<{
    name: "cloud_agent_code_reviews";
    schema: undefined;
    columns: {
        id: drizzle_orm_pg_core.PgColumn<{
            name: "id";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owned_by_organization_id: drizzle_orm_pg_core.PgColumn<{
            name: "owned_by_organization_id";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owned_by_user_id: drizzle_orm_pg_core.PgColumn<{
            name: "owned_by_user_id";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        platform_integration_id: drizzle_orm_pg_core.PgColumn<{
            name: "platform_integration_id";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        repo_full_name: drizzle_orm_pg_core.PgColumn<{
            name: "repo_full_name";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_number: drizzle_orm_pg_core.PgColumn<{
            name: "pr_number";
            tableName: "cloud_agent_code_reviews";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_url: drizzle_orm_pg_core.PgColumn<{
            name: "pr_url";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_title: drizzle_orm_pg_core.PgColumn<{
            name: "pr_title";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_author: drizzle_orm_pg_core.PgColumn<{
            name: "pr_author";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_author_github_id: drizzle_orm_pg_core.PgColumn<{
            name: "pr_author_github_id";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        base_ref: drizzle_orm_pg_core.PgColumn<{
            name: "base_ref";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        head_ref: drizzle_orm_pg_core.PgColumn<{
            name: "head_ref";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        head_sha: drizzle_orm_pg_core.PgColumn<{
            name: "head_sha";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        platform: drizzle_orm_pg_core.PgColumn<{
            name: "platform";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        platform_project_id: drizzle_orm_pg_core.PgColumn<{
            name: "platform_project_id";
            tableName: "cloud_agent_code_reviews";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        session_id: drizzle_orm_pg_core.PgColumn<{
            name: "session_id";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        cli_session_id: drizzle_orm_pg_core.PgColumn<{
            name: "cli_session_id";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: drizzle_orm_pg_core.PgColumn<{
            name: "status";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        error_message: drizzle_orm_pg_core.PgColumn<{
            name: "error_message";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        terminal_reason: drizzle_orm_pg_core.PgColumn<{
            name: "terminal_reason";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        agent_version: drizzle_orm_pg_core.PgColumn<{
            name: "agent_version";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        check_run_id: drizzle_orm_pg_core.PgColumn<{
            name: "check_run_id";
            tableName: "cloud_agent_code_reviews";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        model: drizzle_orm_pg_core.PgColumn<{
            name: "model";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        total_tokens_in: drizzle_orm_pg_core.PgColumn<{
            name: "total_tokens_in";
            tableName: "cloud_agent_code_reviews";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        total_tokens_out: drizzle_orm_pg_core.PgColumn<{
            name: "total_tokens_out";
            tableName: "cloud_agent_code_reviews";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        total_cost_musd: drizzle_orm_pg_core.PgColumn<{
            name: "total_cost_musd";
            tableName: "cloud_agent_code_reviews";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        started_at: drizzle_orm_pg_core.PgColumn<{
            name: "started_at";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completed_at: drizzle_orm_pg_core.PgColumn<{
            name: "completed_at";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        created_at: drizzle_orm_pg_core.PgColumn<{
            name: "created_at";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updated_at: drizzle_orm_pg_core.PgColumn<{
            name: "updated_at";
            tableName: "cloud_agent_code_reviews";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
type CloudAgentCodeReview = typeof cloud_agent_code_reviews.$inferSelect;
declare const app_builder_projects: drizzle_orm_pg_core.PgTableWithColumns<{
    name: "app_builder_projects";
    schema: undefined;
    columns: {
        id: drizzle_orm_pg_core.PgColumn<{
            name: "id";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        created_by_user_id: drizzle_orm_pg_core.PgColumn<{
            name: "created_by_user_id";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owned_by_user_id: drizzle_orm_pg_core.PgColumn<{
            name: "owned_by_user_id";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owned_by_organization_id: drizzle_orm_pg_core.PgColumn<{
            name: "owned_by_organization_id";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        session_id: drizzle_orm_pg_core.PgColumn<{
            name: "session_id";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        title: drizzle_orm_pg_core.PgColumn<{
            name: "title";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        model_id: drizzle_orm_pg_core.PgColumn<{
            name: "model_id";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        template: drizzle_orm_pg_core.PgColumn<{
            name: "template";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        deployment_id: drizzle_orm_pg_core.PgColumn<{
            name: "deployment_id";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        last_message_at: drizzle_orm_pg_core.PgColumn<{
            name: "last_message_at";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        git_repo_full_name: drizzle_orm_pg_core.PgColumn<{
            name: "git_repo_full_name";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        git_platform_integration_id: drizzle_orm_pg_core.PgColumn<{
            name: "git_platform_integration_id";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        migrated_at: drizzle_orm_pg_core.PgColumn<{
            name: "migrated_at";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        created_at: drizzle_orm_pg_core.PgColumn<{
            name: "created_at";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updated_at: drizzle_orm_pg_core.PgColumn<{
            name: "updated_at";
            tableName: "app_builder_projects";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
declare const auto_triage_tickets: drizzle_orm_pg_core.PgTableWithColumns<{
    name: "auto_triage_tickets";
    schema: undefined;
    columns: {
        id: drizzle_orm_pg_core.PgColumn<{
            name: "id";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owned_by_organization_id: drizzle_orm_pg_core.PgColumn<{
            name: "owned_by_organization_id";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owned_by_user_id: drizzle_orm_pg_core.PgColumn<{
            name: "owned_by_user_id";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        platform_integration_id: drizzle_orm_pg_core.PgColumn<{
            name: "platform_integration_id";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        platform: drizzle_orm_pg_core.PgColumn<{
            name: "platform";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        repo_full_name: drizzle_orm_pg_core.PgColumn<{
            name: "repo_full_name";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_number: drizzle_orm_pg_core.PgColumn<{
            name: "issue_number";
            tableName: "auto_triage_tickets";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_url: drizzle_orm_pg_core.PgColumn<{
            name: "issue_url";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_title: drizzle_orm_pg_core.PgColumn<{
            name: "issue_title";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_body: drizzle_orm_pg_core.PgColumn<{
            name: "issue_body";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_author: drizzle_orm_pg_core.PgColumn<{
            name: "issue_author";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_type: drizzle_orm_pg_core.PgColumn<{
            name: "issue_type";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: "issue" | "pull_request";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: "issue" | "pull_request";
        }>;
        issue_labels: drizzle_orm_pg_core.PgColumn<{
            name: "issue_labels";
            tableName: "auto_triage_tickets";
            dataType: "array";
            columnType: "PgArray";
            data: string[];
            driverParam: string | string[];
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: drizzle_orm.Column<{
                name: "";
                tableName: "auto_triage_tickets";
                dataType: "string";
                columnType: "PgText";
                data: string;
                driverParam: string;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            identity: undefined;
            generated: undefined;
        }, {}, {
            baseBuilder: drizzle_orm_pg_core.PgColumnBuilder<{
                name: "";
                dataType: "string";
                columnType: "PgText";
                data: string;
                enumValues: [string, ...string[]];
                driverParam: string;
            }, {}, {}, drizzle_orm.ColumnBuilderExtraConfig>;
            size: undefined;
        }>;
        classification: drizzle_orm_pg_core.PgColumn<{
            name: "classification";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: "feature" | "bug" | "question" | "duplicate" | "unclear";
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: "feature" | "bug" | "question" | "duplicate" | "unclear";
        }>;
        confidence: drizzle_orm_pg_core.PgColumn<{
            name: "confidence";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgNumeric";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        intent_summary: drizzle_orm_pg_core.PgColumn<{
            name: "intent_summary";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        related_files: drizzle_orm_pg_core.PgColumn<{
            name: "related_files";
            tableName: "auto_triage_tickets";
            dataType: "array";
            columnType: "PgArray";
            data: string[];
            driverParam: string | string[];
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: drizzle_orm.Column<{
                name: "";
                tableName: "auto_triage_tickets";
                dataType: "string";
                columnType: "PgText";
                data: string;
                driverParam: string;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            identity: undefined;
            generated: undefined;
        }, {}, {
            baseBuilder: drizzle_orm_pg_core.PgColumnBuilder<{
                name: "";
                dataType: "string";
                columnType: "PgText";
                data: string;
                enumValues: [string, ...string[]];
                driverParam: string;
            }, {}, {}, drizzle_orm.ColumnBuilderExtraConfig>;
            size: undefined;
        }>;
        is_duplicate: drizzle_orm_pg_core.PgColumn<{
            name: "is_duplicate";
            tableName: "auto_triage_tickets";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        duplicate_of_ticket_id: drizzle_orm_pg_core.PgColumn<{
            name: "duplicate_of_ticket_id";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        similarity_score: drizzle_orm_pg_core.PgColumn<{
            name: "similarity_score";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgNumeric";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        qdrant_point_id: drizzle_orm_pg_core.PgColumn<{
            name: "qdrant_point_id";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        session_id: drizzle_orm_pg_core.PgColumn<{
            name: "session_id";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        should_auto_fix: drizzle_orm_pg_core.PgColumn<{
            name: "should_auto_fix";
            tableName: "auto_triage_tickets";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: drizzle_orm_pg_core.PgColumn<{
            name: "status";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: "failed" | "pending" | "analyzing" | "actioned" | "skipped";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: "failed" | "pending" | "analyzing" | "actioned" | "skipped";
        }>;
        action_taken: drizzle_orm_pg_core.PgColumn<{
            name: "action_taken";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: "pr_created" | "comment_posted" | "closed_duplicate" | "needs_clarification";
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: "pr_created" | "comment_posted" | "closed_duplicate" | "needs_clarification";
        }>;
        action_metadata: drizzle_orm_pg_core.PgColumn<{
            name: "action_metadata";
            tableName: "auto_triage_tickets";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        error_message: drizzle_orm_pg_core.PgColumn<{
            name: "error_message";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        started_at: drizzle_orm_pg_core.PgColumn<{
            name: "started_at";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completed_at: drizzle_orm_pg_core.PgColumn<{
            name: "completed_at";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        created_at: drizzle_orm_pg_core.PgColumn<{
            name: "created_at";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updated_at: drizzle_orm_pg_core.PgColumn<{
            name: "updated_at";
            tableName: "auto_triage_tickets";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
type AutoTriageTicket = typeof auto_triage_tickets.$inferSelect;
declare const auto_fix_tickets: drizzle_orm_pg_core.PgTableWithColumns<{
    name: "auto_fix_tickets";
    schema: undefined;
    columns: {
        id: drizzle_orm_pg_core.PgColumn<{
            name: "id";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owned_by_organization_id: drizzle_orm_pg_core.PgColumn<{
            name: "owned_by_organization_id";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owned_by_user_id: drizzle_orm_pg_core.PgColumn<{
            name: "owned_by_user_id";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        platform_integration_id: drizzle_orm_pg_core.PgColumn<{
            name: "platform_integration_id";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        triage_ticket_id: drizzle_orm_pg_core.PgColumn<{
            name: "triage_ticket_id";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        platform: drizzle_orm_pg_core.PgColumn<{
            name: "platform";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        repo_full_name: drizzle_orm_pg_core.PgColumn<{
            name: "repo_full_name";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_number: drizzle_orm_pg_core.PgColumn<{
            name: "issue_number";
            tableName: "auto_fix_tickets";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_url: drizzle_orm_pg_core.PgColumn<{
            name: "issue_url";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_title: drizzle_orm_pg_core.PgColumn<{
            name: "issue_title";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_body: drizzle_orm_pg_core.PgColumn<{
            name: "issue_body";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_author: drizzle_orm_pg_core.PgColumn<{
            name: "issue_author";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issue_labels: drizzle_orm_pg_core.PgColumn<{
            name: "issue_labels";
            tableName: "auto_fix_tickets";
            dataType: "array";
            columnType: "PgArray";
            data: string[];
            driverParam: string | string[];
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: drizzle_orm.Column<{
                name: "";
                tableName: "auto_fix_tickets";
                dataType: "string";
                columnType: "PgText";
                data: string;
                driverParam: string;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            identity: undefined;
            generated: undefined;
        }, {}, {
            baseBuilder: drizzle_orm_pg_core.PgColumnBuilder<{
                name: "";
                dataType: "string";
                columnType: "PgText";
                data: string;
                enumValues: [string, ...string[]];
                driverParam: string;
            }, {}, {}, drizzle_orm.ColumnBuilderExtraConfig>;
            size: undefined;
        }>;
        trigger_source: drizzle_orm_pg_core.PgColumn<{
            name: "trigger_source";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: "label" | "review_comment";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: "label" | "review_comment";
        }>;
        review_comment_id: drizzle_orm_pg_core.PgColumn<{
            name: "review_comment_id";
            tableName: "auto_fix_tickets";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        review_comment_body: drizzle_orm_pg_core.PgColumn<{
            name: "review_comment_body";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        file_path: drizzle_orm_pg_core.PgColumn<{
            name: "file_path";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        line_number: drizzle_orm_pg_core.PgColumn<{
            name: "line_number";
            tableName: "auto_fix_tickets";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        diff_hunk: drizzle_orm_pg_core.PgColumn<{
            name: "diff_hunk";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_head_ref: drizzle_orm_pg_core.PgColumn<{
            name: "pr_head_ref";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        classification: drizzle_orm_pg_core.PgColumn<{
            name: "classification";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: "feature" | "bug" | "question" | "unclear";
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: "feature" | "bug" | "question" | "unclear";
        }>;
        confidence: drizzle_orm_pg_core.PgColumn<{
            name: "confidence";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgNumeric";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        intent_summary: drizzle_orm_pg_core.PgColumn<{
            name: "intent_summary";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        related_files: drizzle_orm_pg_core.PgColumn<{
            name: "related_files";
            tableName: "auto_fix_tickets";
            dataType: "array";
            columnType: "PgArray";
            data: string[];
            driverParam: string | string[];
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: drizzle_orm.Column<{
                name: "";
                tableName: "auto_fix_tickets";
                dataType: "string";
                columnType: "PgText";
                data: string;
                driverParam: string;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            identity: undefined;
            generated: undefined;
        }, {}, {
            baseBuilder: drizzle_orm_pg_core.PgColumnBuilder<{
                name: "";
                dataType: "string";
                columnType: "PgText";
                data: string;
                enumValues: [string, ...string[]];
                driverParam: string;
            }, {}, {}, drizzle_orm.ColumnBuilderExtraConfig>;
            size: undefined;
        }>;
        session_id: drizzle_orm_pg_core.PgColumn<{
            name: "session_id";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        cli_session_id: drizzle_orm_pg_core.PgColumn<{
            name: "cli_session_id";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_number: drizzle_orm_pg_core.PgColumn<{
            name: "pr_number";
            tableName: "auto_fix_tickets";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_url: drizzle_orm_pg_core.PgColumn<{
            name: "pr_url";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pr_branch: drizzle_orm_pg_core.PgColumn<{
            name: "pr_branch";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: drizzle_orm_pg_core.PgColumn<{
            name: "status";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: "failed" | "completed" | "cancelled" | "pending" | "running";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: "failed" | "completed" | "cancelled" | "pending" | "running";
        }>;
        error_message: drizzle_orm_pg_core.PgColumn<{
            name: "error_message";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        started_at: drizzle_orm_pg_core.PgColumn<{
            name: "started_at";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completed_at: drizzle_orm_pg_core.PgColumn<{
            name: "completed_at";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        created_at: drizzle_orm_pg_core.PgColumn<{
            name: "created_at";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updated_at: drizzle_orm_pg_core.PgColumn<{
            name: "updated_at";
            tableName: "auto_fix_tickets";
            dataType: "string";
            columnType: "PgTimestampString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
type AutoFixTicket = typeof auto_fix_tickets.$inferSelect;
type BotRequestStatus = 'pending' | 'completed' | 'error';
type BotRequestStep = {
    stepNumber: number;
    finishReason: string;
    toolCalls?: Array<{
        name: string;
        args: Record<string, unknown>;
    }>;
    toolResults?: Array<{
        name: string;
        result: unknown;
    }>;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    };
};

/**
 * Auto Triage - Zod Validation Schemas
 *
 * Runtime validation schemas for auto triage inputs and outputs.
 * Follows validation patterns used throughout the codebase.
 */

/**
 * Response type for list triage tickets
 */
type ListTriageTicketsResponse = {
    tickets: AutoTriageTicket[];
    total: number;
    hasMore: boolean;
};

type SuccessResult<TOk = {}> = {
    success: true;
} & TOk;
type FailureResult<TErr = void> = {
    success: false;
    error: TErr;
};

type TRPCContext = {
    user: User;
};

type SessionLogEntry = {
    timestamp: string;
    eventType: string;
    message: string;
    content?: string;
};

/**
 * Code Reviews - Zod Validation Schemas
 *
 * Runtime validation schemas for code review inputs.
 * Follows validation patterns used throughout the codebase.
 */

/**
 * Response type for list code reviews
 */
type ListCodeReviewsResponse = {
    reviews: CloudAgentCodeReview[];
    total: number;
    hasMore: boolean;
};

/**
 * Code review event structure (used by SSE/cloud-agent flow)
 * Matches the CodeReviewEvent type from Cloudflare Worker
 */
type ReviewEvent = {
    timestamp: string;
    eventType: string;
    message?: string;
    content?: string;
    sessionId?: string;
};

/**
 * GitLab API Adapter
 *
 * Provides OAuth-based authentication and API operations for GitLab.
 * Supports both GitLab.com and self-hosted GitLab instances.
 */

/**
 * GitLab API response types
 */
type GitLabUser = {
    id: number;
    username: string;
    name: string;
    email: string;
    avatar_url: string;
    web_url: string;
};
/**
 * Result of validating a GitLab instance
 */
type GitLabInstanceValidationResult = {
    valid: boolean;
    version?: string;
    revision?: string;
    enterprise?: boolean;
    error?: string;
};
/**
 * Result of validating a Personal Access Token
 */
type GitLabPATValidationResult = {
    valid: boolean;
    user?: GitLabUser;
    tokenInfo?: {
        id: number;
        name: string;
        scopes: string[];
        expiresAt: string | null;
        active: boolean;
        lastUsedAt: string | null;
    };
    error?: string;
    missingScopes?: string[];
    warnings?: string[];
};

/** Mirrors the worker's ImageVersionEntry schema (KV stored version metadata) */
type ImageVersionEntry = {
    openclawVersion: string;
    variant: string;
    imageTag: string;
    imageDigest: string | null;
    publishedAt: string;
};
/** Response from PATCH /api/platform/channels */
type ChannelsPatchResponse = {
    telegram: boolean;
    discord: boolean;
    slackBot: boolean;
    slackApp: boolean;
};
/** Response from PATCH /api/platform/secrets */
type SecretsPatchResponse = {
    /** Field keys that have a value set after the patch */
    configured: SecretFieldKey[];
};
/** A pending channel pairing request (e.g. from Telegram DM) */
type PairingRequest = {
    code: string;
    id: string;
    channel: string;
    meta?: unknown;
    createdAt?: string;
};
/** Response from GET /api/platform/pairing */
type PairingListResponse = {
    requests: PairingRequest[];
};
/** Response from POST /api/platform/pairing/approve */
type PairingApproveResponse = {
    success: boolean;
    message: string;
};
/** A pending device pairing request (e.g. Control UI or node) */
type DevicePairingRequest = {
    requestId: string;
    deviceId: string;
    role?: string;
    platform?: string;
    clientId?: string;
    ts?: number;
};
/** Response from GET /api/platform/device-pairing */
type DevicePairingListResponse = {
    requests: DevicePairingRequest[];
};
/** Response from POST /api/platform/device-pairing/approve */
type DevicePairingApproveResponse = {
    success: boolean;
    message: string;
};
/** Fly Machine guest spec (CPU/memory configuration) */
type MachineSize = {
    cpus: number;
    memory_mb: number;
    cpu_kind?: 'shared' | 'performance';
};
/** Response from GET /api/platform/status and GET /api/kiloclaw/status */
type PlatformStatusResponse = {
    userId: string | null;
    sandboxId: string | null;
    status: 'provisioned' | 'starting' | 'restarting' | 'running' | 'stopped' | 'destroying' | null;
    provisionedAt: number | null;
    lastStartedAt: number | null;
    lastStoppedAt: number | null;
    envVarCount: number;
    secretCount: number;
    channelCount: number;
    flyAppName: string | null;
    flyMachineId: string | null;
    flyVolumeId: string | null;
    flyRegion: string | null;
    machineSize: MachineSize | null;
    openclawVersion: string | null;
    imageVariant: string | null;
    trackedImageTag: string | null;
    trackedImageDigest: string | null;
    googleConnected: boolean;
    gmailNotificationsEnabled: boolean;
    execSecurity: string | null;
    execAsk: string | null;
};
/** Response from GET /api/platform/debug-status (internal/admin only). */
type PlatformDebugStatusResponse = PlatformStatusResponse & {
    pendingDestroyMachineId: string | null;
    pendingDestroyVolumeId: string | null;
    pendingPostgresMarkOnFinalize: boolean;
    lastMetadataRecoveryAt: number | null;
    lastLiveCheckAt: number | null;
    alarmScheduledAt: number | null;
    lastDestroyErrorOp: 'machine' | 'volume' | 'recover' | null;
    lastDestroyErrorStatus: number | null;
    lastDestroyErrorMessage: string | null;
    lastDestroyErrorAt: number | null;
    lastRestartErrorMessage: string | null;
    lastRestartErrorAt: number | null;
};
/** A Fly volume snapshot. */
type VolumeSnapshot = {
    id: string;
    created_at: string;
    digest: string;
    retention_days: number;
    size: number;
    status: string;
    volume_size: number;
};
/** Response from GET /api/kiloclaw/config */
type UserConfigResponse = {
    envVarKeys: string[];
    secretCount: number;
    kilocodeDefaultModel: string | null;
    hasKiloCodeApiKey: boolean;
    kilocodeApiKeyExpiresAt?: string | null;
    /** Per catalog entry ID → whether all fields for that entry are configured. */
    configuredSecrets: Record<string, boolean>;
};
/** Response from POST /api/platform/doctor */
type DoctorResponse = {
    success: boolean;
    output: string;
};
/** Response from POST /api/admin/machine/restart */
type RestartMachineResponse = {
    success: boolean;
    message?: string;
    error?: string;
};
/** Response from GET /api/platform/gateway/status */
type GatewayProcessStatusResponse = {
    state: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'shutting_down';
    pid: number | null;
    uptime: number;
    restarts: number;
    lastExit: {
        code: number | null;
        signal: string | null;
        at: string;
    } | null;
};
/** Response from POST /api/platform/gateway/{start|stop|restart} */
type GatewayProcessActionResponse = {
    ok: boolean;
};
/** Response from POST /api/platform/config/restore */
type ConfigRestoreResponse = {
    ok: boolean;
    signaled: boolean;
};
/** Response from GET /api/platform/gateway/ready (opaque — shape depends on OpenClaw version) */
type GatewayReadyResponse = Record<string, unknown>;
/** Response from GET /api/platform/controller-version. Null fields = old controller. */
type ControllerVersionResponse = {
    version: string | null;
    commit: string | null;
    openclawVersion?: string | null;
    openclawCommit?: string | null;
};
/** Response from POST/DELETE /api/platform/google-credentials */
type GoogleCredentialsResponse = {
    googleConnected: boolean;
};
/** Response from POST/DELETE /api/platform/gmail-notifications */
type GmailNotificationsResponse = {
    gmailNotificationsEnabled: boolean;
};
/** A candidate volume for admin volume reassociation. */
type CandidateVolume = {
    id: string;
    name: string;
    state: 'created' | 'attached' | 'detached';
    size_gb: number;
    region: string;
    attached_machine_id: string | null;
    created_at: string;
    isCurrent: boolean;
};
/** Response from GET /api/platform/candidate-volumes */
type CandidateVolumesResponse = {
    currentVolumeId: string | null;
    volumes: CandidateVolume[];
};
/** Response from POST /api/platform/reassociate-volume */
type ReassociateVolumeResponse = {
    previousVolumeId: string | null;
    newVolumeId: string;
    newRegion: string;
};
/** Response from GET /api/platform/regions */
type RegionsResponse = {
    regions: string[];
    source: 'kv' | 'env' | 'default';
    raw: string;
};
/** Response from PUT /api/platform/regions */
type UpdateRegionsResponse = {
    ok: true;
    regions: string[];
    raw: string;
};

/** Keep in sync with: kiloclaw/controller/src/routes/files.ts, kiloclaw/src/.../gateway.ts (Zod) */
interface FileNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    children?: FileNode[];
}

type AdminKiloclawInstance = {
    id: string;
    user_id: string;
    sandbox_id: string;
    created_at: string;
    destroyed_at: string | null;
    suspended_at: string | null;
    user_email: string | null;
};

type AdminAppBuilderProject = {
    id: string;
    title: string;
    model_id: string;
    template: string | null;
    session_id: string | null;
    deployment_id: string | null;
    created_by_user_id: string | null;
    owned_by_user_id: string | null;
    owned_by_organization_id: string | null;
    created_at: string;
    updated_at: string;
    last_message_at: string | null;
    owner_email: string | null;
    owner_org_name: string | null;
    is_deployed: boolean;
};
type AdminAppBuilderProjectDetail = AdminAppBuilderProject & {
    cli_session_id: string | null;
};

type FeatureInterestLeaderboard = {
    feature: string;
    unique_signups: number;
    total_signups: number;
};
type FeatureSlugLeaderboard = {
    feature_slug: string;
    unique_signups: number;
    total_signups: number;
};
type FeatureInterestTimelineEntry = {
    week_start: string;
    feature: string;
    signups: number;
};
type FeatureSignupUser = {
    email: string;
    name: string;
    company: string | null;
    role: string | null;
    signed_up_at: string;
};

type AdminDeploymentTableProps = {
    id: string;
    deployment_slug: string;
    repository_source: string;
    branch: string;
    deployment_url: string;
    source_type: 'github' | 'git' | 'app-builder';
    created_at: string;
    last_deployed_at: string | null;
    owned_by_user_id: string | null;
    owned_by_organization_id: string | null;
    owner_email: string | null;
    owner_org_name: string | null;
    created_by_user_id: string | null;
    created_by_user_email: string | null;
    latest_build_status: BuildStatus | null;
    latest_build_id: string | null;
};
type AdminDeploymentBuild = {
    id: string;
    status: BuildStatus;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
};

type UserBalanceUpdates = {
    user: Pick<User, 'id' | 'updated_at' | 'microdollars_used' | 'total_microdollars_acquired'>;
    user_update: Pick<User, 'microdollars_used' | 'total_microdollars_acquired'>;
    accounting_error_mUsd: number;
    updatesForOriginalBaseline: {
        id: string;
        baseline: number;
        db: number | null;
    }[];
    updatesForExpirationBaseline: {
        id: string;
        baseline: number;
        db: number | null;
    }[];
};

type OpenPullRequestCounts = {
    totalOpenPullRequests: number;
    teamOpenPullRequests: number;
    externalOpenPullRequests: number;
    updatedAt: string;
};

type PullRequestReviewStatus = 'changes_requested' | 'approved' | 'commented' | 'no_reviews';
type ExternalOpenPullRequest = {
    number: number;
    title: string;
    url: string;
    repo: string;
    authorLogin: string;
    createdAt: string;
    ageDays: number;
    commentCount: number;
    teamCommented: boolean;
    reviewStatus: PullRequestReviewStatus;
};
type OpenPullRequestsSummary = OpenPullRequestCounts & {
    externalOpenPullRequestsList: ExternalOpenPullRequest[];
};

type ExternalMergedPullRequest = {
    number: number;
    title: string;
    url: string;
    authorLogin: string;
    mergedAt: string;
};

type ExternalClosedPullRequestStatus = 'merged' | 'closed';
type ExternalClosedPullRequest = {
    number: number;
    title: string;
    url: string;
    repo: string;
    authorLogin: string;
    closedAt: string;
    mergedAt: string | null;
    status: ExternalClosedPullRequestStatus;
    displayDate: string;
};

type ExternalClosedPullRequestsWithWeekStats = {
    prs: ExternalClosedPullRequest[];
    thisWeekMergedCount: number;
    thisWeekClosedCount: number;
    weekStart: string;
    weekEnd?: string;
};

/**
 * Captured request from the worker.
 */
type CapturedRequest = {
    id: string;
    timestamp: string;
    method: string;
    path: string;
    queryString: string | null;
    headers: Record<string, string>;
    body: string;
    contentType: string | null;
    sourceIp: string | null;
    startedAt: string | null;
    completedAt: string | null;
    processStatus: 'captured' | 'inprogress' | 'success' | 'failed';
    cloudAgentSessionId: string | null;
    errorMessage: string | null;
};
/**
 * Captured request enriched with kiloSessionId from PostgreSQL lookup.
 * Used for UI display where we need the cli_sessions.id for navigation.
 */
type EnrichedCapturedRequest = CapturedRequest & {
    kiloSessionId: string | null;
};

type UnifiedInvoice = {
    id: string;
    number: string | null;
    status: string;
    amount_due: number;
    currency: string;
    created: number;
    hosted_invoice_url: string | null;
    invoice_pdf: string | null;
    invoice_type?: 'seats' | 'topup';
    description?: string | null;
};

declare const OrganizationSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    microdollars_used: z.ZodNumber;
    total_microdollars_acquired: z.ZodNumber;
    next_credit_expiration_at: z.ZodNullable<z.ZodString>;
    stripe_customer_id: z.ZodNullable<z.ZodString>;
    auto_top_up_enabled: z.ZodBoolean;
    settings: z.ZodObject<{
        model_allow_list: z.ZodOptional<z.ZodArray<z.ZodString>>;
        provider_allow_list: z.ZodOptional<z.ZodArray<z.ZodString>>;
        model_deny_list: z.ZodOptional<z.ZodArray<z.ZodString>>;
        provider_deny_list: z.ZodOptional<z.ZodArray<z.ZodString>>;
        default_model: z.ZodOptional<z.ZodString>;
        data_collection: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            allow: "allow";
            deny: "deny";
        }>>>;
        enable_usage_limits: z.ZodOptional<z.ZodBoolean>;
        code_indexing_enabled: z.ZodOptional<z.ZodBoolean>;
        projects_ui_enabled: z.ZodOptional<z.ZodBoolean>;
        minimum_balance: z.ZodOptional<z.ZodNumber>;
        minimum_balance_alert_email: z.ZodOptional<z.ZodArray<z.ZodEmail>>;
        suppress_trial_messaging: z.ZodOptional<z.ZodBoolean>;
        oss_sponsorship_tier: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>>;
        github_app_type: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            standard: "standard";
            lite: "lite";
        }>>>;
        oss_monthly_credit_amount_microdollars: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        oss_credits_last_reset_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        oss_github_url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>;
    seat_count: z.ZodDefault<z.ZodNumber>;
    require_seats: z.ZodDefault<z.ZodBoolean>;
    created_by_kilo_user_id: z.ZodNullable<z.ZodString>;
    deleted_at: z.ZodNullable<z.ZodString>;
    sso_domain: z.ZodNullable<z.ZodString>;
    plan: z.ZodEnum<{
        teams: "teams";
        enterprise: "enterprise";
    }>;
    free_trial_end_at: z.ZodNullable<z.ZodString>;
    company_domain: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type UserOrganizationWithSeats = {
    organizationName: string;
    organizationId: Organization['id'];
    role: OrganizationRole;
    memberCount: number;
    balance: number;
    requireSeats: boolean;
    plan: OrganizationPlan;
    created_at: Organization['created_at'];
    seatCount: {
        used: number;
        total: number;
    };
};
type InvitedMember = {
    email: string;
    role: OrganizationRole;
    inviteDate: string | null;
    inviteToken: string;
    inviteId: string;
    status: 'invited';
    inviteUrl: string;
    dailyUsageLimitUsd: number | null;
    currentDailyUsageUsd: number | null;
};
type ActiveMember = {
    id: string;
    name: string;
    email: string;
    role: OrganizationRole;
    status: 'active';
    inviteDate: string | null;
    dailyUsageLimitUsd: number | null;
    currentDailyUsageUsd: number | null;
};
type OrganizationMember = InvitedMember | ActiveMember;
type OrganizationWithMembers = z.infer<typeof OrganizationSchema> & {
    members: OrganizationMember[];
};

/**
 * Auto Fix - Zod Validation Schemas
 *
 * Runtime validation schemas for auto fix inputs and outputs.
 * Follows validation patterns used throughout the codebase.
 */

/**
 * Response type for list fix tickets
 */
type ListFixTicketsResponse = {
    tickets: AutoFixTicket[];
    total: number;
    hasMore: boolean;
};

type Severity = 'critical' | 'high' | 'medium' | 'low';
type DashboardStats = {
    sla: {
        overall: {
            total: number;
            withinSla: number;
            overdue: number;
        };
        bySeverity: Record<Severity, {
            total: number;
            withinSla: number;
            overdue: number;
        }>;
        untrackedCount: number;
    };
    severity: Record<Severity, number>;
    status: {
        open: number;
        fixed: number;
        ignored: number;
    };
    analysis: {
        total: number;
        analyzed: number;
        exploitable: number;
        notExploitable: number;
        triageComplete: number;
        safeToDismiss: number;
        needsReview: number;
        analyzing: number;
        notAnalyzed: number;
        failed: number;
    };
    mttr: {
        bySeverity: Record<Severity, {
            avgDays: number | null;
            medianDays: number | null;
            count: number;
            slaDays: number;
        }>;
    };
    overdue: Array<{
        id: string;
        severity: string;
        title: string;
        repoFullName: string;
        packageName: string;
        slaDueAt: string;
        daysOverdue: number;
    }>;
    repoHealth: Array<{
        repoFullName: string;
        critical: number;
        high: number;
        medium: number;
        low: number;
        overdue: number;
        slaCompliancePercent: number;
    }>;
};

type GenerateImageUploadUrlResult = {
    signedUrl: string;
    key: string;
    expiresAt: string;
};

/**
 * Generic schema and type for image attachments.
 *
 * This file is intentionally isolated to avoid circular dependencies.
 * It can be imported from both cloud-agent and app-builder modules.
 *
 * R2 path structure: {bucket}/{userId}/{path}/{filename}
 * - userId is derived from the authenticated user context
 * - path is app-specific (e.g., "app-builder/msg-uuid", "cloud-agent/session123")
 * - files are either specified explicitly or all files at the path are downloaded
 */

/**
 * Generic images schema for attaching images to prompts.
 */
declare const imagesSchema: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    files: z.ZodArray<z.ZodString>;
}, z.core.$strip>>;
/**
 * Image attachments with path and optional ordered list of filenames.
 * Derived from imagesSchema zod validator.
 */
type Images = NonNullable<z.infer<typeof imagesSchema>>;

/**
 * Cloud Agent Types
 *
 * Type definitions for cloud agent chat messages and related structures.
 * These mostly mimic the CLI's message format.
 *
 * IMPORTANT: This file should NOT import from other cloud-agent modules
 * to avoid circular dependencies. It serves as the base types file.
 */

/**
 * Cloud agent message
 * Represents all types of messages in the chat (user, assistant, system)
 * Used for streaming state with Jotai atoms
 */
interface CloudMessage {
    ts: number;
    type: 'user' | 'assistant' | 'system';
    say?: string;
    ask?: string;
    text?: string;
    content?: string;
    partial?: boolean;
    metadata?: Record<string, unknown>;
    toolExecutions?: ToolExecution[];
    images?: Images;
}
/**
 * Tool execution
 * Represents a tool/command that was executed during the session
 */
interface ToolExecution {
    toolName: string;
    input: Record<string, unknown>;
    output?: string;
    error?: string;
    timestamp: string;
}
/**
 * Raw Kilocode CLI event - preserved exactly as received from stdout JSON.
 * These events come directly from the Kilocode CLI and may contain any fields.
 */
type KilocodeEvent = Record<string, unknown>;
/**
 * System events use streamEventType discriminator to avoid collision with Kilocode's type field.
 * These are internal events generated by the streaming infrastructure.
 */
type SystemStatusEvent = {
    streamEventType: 'status';
    message: string;
    timestamp: string;
    sessionId?: string;
};
type SystemOutputEvent = {
    streamEventType: 'output';
    content: string;
    source: 'stdout' | 'stderr';
    timestamp: string;
    sessionId?: string;
};
type SystemErrorEvent = {
    streamEventType: 'error';
    error: string;
    details?: unknown;
    timestamp: string;
    sessionId?: string;
};
type SystemCompleteEvent = {
    streamEventType: 'complete';
    sessionId: string;
    exitCode: number;
    metadata: {
        executionTimeMs: number;
        workspace: string;
        userId: string;
        startedAt: string;
        completedAt: string;
    };
};
type SystemKilocodeEvent = {
    streamEventType: 'kilocode';
    payload: KilocodeEvent;
    sessionId?: string;
};
type SystemInterruptedEvent = {
    streamEventType: 'interrupted';
    reason: string;
    timestamp: string;
    sessionId?: string;
};
/**
 * Union of all streaming event types.
 * All events now use streamEventType discriminator - Kilocode CLI events are wrapped in SystemKilocodeEvent.
 */
type StreamEvent = SystemKilocodeEvent | SystemStatusEvent | SystemOutputEvent | SystemErrorEvent | SystemCompleteEvent | SystemInterruptedEvent;

type AppBuilderProject = typeof app_builder_projects.$inferSelect;
/**
 * Result of creating a project
 */
type CreateProjectResult = {
    projectId: string;
};
/**
 * Worker version for cloud agent sessions
 */
type WorkerVersion = 'v1' | 'v2';
/**
 * Session info returned with project data.
 * `initiated` and `prepared` are only populated for the active session
 * (the one fetched from the cloud-agent DO). Ended sessions have both as null.
 *
 * Used in ProjectManager.buildSessions() for routing decisions; not stored on sessions.
 */
type ProjectSessionInfo = {
    id: string;
    cloud_agent_session_id: string;
    worker_version: WorkerVersion;
    ended_at: string | null;
    title: string | null;
    /**
     * Whether the cloud agent session has been initiated (agent started executing).
     * - false: Session is prepared but not yet initiated (need to call startSessionForProject)
     * - true: Session has been initiated
     * - null: Ended session, unknown, or error state
     */
    initiated: boolean | null;
    /**
     * Whether the cloud agent session has been prepared (DO has state stored).
     * - false: Legacy session — DO has no state, needs prepareLegacySession before messaging
     * - true: Session is prepared and can use WebSocket-based messaging
     * - null: Ended session, unknown, or error state
     */
    prepared: boolean | null;
};
/**
 * Result of deploying a project
 */
type DeployProjectResult = {
    success: true;
    deploymentId: string;
    deploymentUrl: string;
    alreadyDeployed: boolean;
} | {
    success: false;
    error: 'payment_required' | 'invalid_slug' | 'slug_taken';
    message: string;
};
/**
 * Project with all its messages and session state.
 * Session-level initiated/prepared state lives on each ProjectSessionInfo.
 */
type ProjectWithMessages = AppBuilderProject & {
    messages: CloudMessage[];
    /** All sessions for this project, ordered by created_at ascending */
    sessions: ProjectSessionInfo[];
};
/**
 * Result of migrating a project to GitHub
 */
type MigrateToGitHubResult = {
    success: true;
    githubRepoUrl: string;
    newSessionId: string;
} | {
    success: false;
    error: MigrateToGitHubErrorCode;
};
type MigrateToGitHubErrorCode = 'github_app_not_installed' | 'already_migrated' | 'repo_not_found' | 'repo_not_empty' | 'push_failed' | 'project_not_found' | 'internal_error';
/**
 * Repository info returned by canMigrateToGitHub
 */
type AvailableRepo = {
    fullName: string;
    createdAt: string;
    isPrivate: boolean;
};
/**
 * Pre-flight check result for GitHub migration
 * User-created repository approach: returns info needed to guide user through creating repo
 */
type CanMigrateToGitHubResult = {
    /** Whether the owner has a GitHub App installation */
    hasGitHubIntegration: boolean;
    /** The GitHub account login where the repo should be created */
    targetAccountName: string | null;
    /** Whether this project has already been migrated */
    alreadyMigrated: boolean;
    /** Suggested repository name based on project title */
    suggestedRepoName: string;
    /** URL to create new repo on GitHub (opens GitHub's new repo page) */
    newRepoUrl: string;
    /** URL to manage GitHub App repo access (for users with selective repo access) */
    installationSettingsUrl: string;
    /** List of repos accessible to the GitHub App installation */
    availableRepos: AvailableRepo[];
    /** Whether the GitHub App has access to all repos ('all') or only selected repos ('selected') */
    repositorySelection: 'all' | 'selected';
};

/** Result of interrupting a session */
type InterruptResult = {
    success: boolean;
    killedProcessIds: string[];
    failedProcessIds: string[];
    message: string;
};

type RenameDeploymentResult = {
    success: true;
    deploymentUrl: string;
} | {
    success: false;
    error: 'not_found' | 'invalid_slug' | 'slug_taken' | 'internal_error';
    message: string;
};
type CheckSlugAvailabilityResult = {
    available: true;
} | {
    available: false;
    reason: 'invalid_slug' | 'slug_taken';
    message: string;
};

type CreateDeploymentResult = {
    success: true;
    deploymentId: string;
    deploymentSlug: string;
    deploymentUrl: string;
} | {
    success: false;
    error: 'payment_required' | 'invalid_slug' | 'slug_taken';
    message: string;
};

declare const rootRouter: _trpc_server.TRPCBuiltRouter<{
    ctx: TRPCContext;
    meta: object;
    errorShape: {
        data: {
            zodError: {
                formErrors: string[];
                fieldErrors: {};
            } | null;
            upstreamCode: string | undefined;
            code: _trpc_server.TRPC_ERROR_CODE_KEY;
            httpStatus: number;
            path?: string;
            stack?: string;
        };
        message: string;
        code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
    };
    transformer: false;
}, _trpc_server.TRPCDecorateCreateRouterOptions<{
    test: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        hello: _trpc_server.TRPCQueryProcedure<{
            input: {
                text: string;
            } | undefined;
            output: {
                greeting: string;
            };
            meta: object;
        }>;
        adminHello: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                message: string;
            };
            meta: object;
        }>;
    }>>;
    organizations: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        members: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            update: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    memberId: string;
                    role?: "owner" | "member" | "billing_manager" | undefined;
                    dailyUsageLimitUsd?: number | null | undefined;
                };
                output: SuccessResult<{
                    updated: string;
                }>;
                meta: object;
            }>;
            remove: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    memberId: string;
                };
                output: SuccessResult<{
                    updated: string;
                }>;
                meta: object;
            }>;
            invite: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    email: string;
                    role: "owner" | "member" | "billing_manager";
                };
                output: {
                    acceptInviteUrl: string;
                };
                meta: object;
            }>;
            deleteInvite: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    inviteId: string;
                };
                output: SuccessResult<{
                    updated: string;
                }>;
                meta: object;
            }>;
        }>>;
        subscription: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            get: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    subscription: stripe.Stripe.Subscription | null;
                    seatsUsed: number;
                    totalSeats: number;
                };
                meta: object;
            }>;
            getByStripeSessionId: _trpc_server.TRPCQueryProcedure<{
                input: {
                    sessionId: string;
                };
                output: {
                    status: "paid";
                };
                meta: object;
            }>;
            getSubscriptionStripeUrl: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    seats: number;
                    cancelUrl: string;
                    plan?: "teams" | "enterprise" | undefined;
                };
                output: {
                    url: string | null;
                };
                meta: object;
            }>;
            cancel: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    success: boolean;
                    message: string;
                };
                meta: object;
            }>;
            stopCancellation: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    success: boolean;
                    message?: string | undefined;
                };
                meta: object;
            }>;
            updateSeatCount: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    newSeatCount: number;
                };
                output: {
                    success: boolean;
                    message?: string | undefined;
                    requiresAction?: boolean | undefined;
                    paymentIntentClientSecret?: string | undefined;
                };
                meta: object;
            }>;
            getCustomerPortalUrl: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    returnUrl?: string | undefined;
                };
                output: {
                    url: string;
                };
                meta: object;
            }>;
        }>>;
        settings: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            listAvailableModels: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    data: {
                        id: string;
                        name: string;
                        created: number;
                        description: string;
                        architecture: {
                            input_modalities: string[];
                            output_modalities: string[];
                            tokenizer: string;
                        };
                        top_provider: {
                            is_moderated: boolean;
                            context_length?: number | null | undefined;
                            max_completion_tokens?: number | null | undefined;
                        };
                        pricing: {
                            prompt: string;
                            completion: string;
                            image?: string | undefined;
                            request?: string | undefined;
                            input_cache_read?: string | undefined;
                            input_cache_write?: string | undefined;
                            web_search?: string | undefined;
                            internal_reasoning?: string | undefined;
                        };
                        context_length: number;
                        preferredIndex?: number | undefined;
                        isFree?: boolean | undefined;
                        settings?: {
                            included_tools: ("apply_diff" | "apply_patch" | "delete_file" | "edit_file" | "search_replace" | "search_and_replace" | "write_file" | "write_to_file")[];
                            excluded_tools: ("apply_diff" | "apply_patch" | "delete_file" | "edit_file" | "search_replace" | "search_and_replace" | "write_file" | "write_to_file")[];
                        } | undefined;
                        versioned_settings?: Record<string, {
                            included_tools: ("apply_diff" | "apply_patch" | "delete_file" | "edit_file" | "search_replace" | "search_and_replace" | "write_file" | "write_to_file")[];
                            excluded_tools: ("apply_diff" | "apply_patch" | "delete_file" | "edit_file" | "search_replace" | "search_and_replace" | "write_file" | "write_to_file")[];
                        }> | undefined;
                        opencode?: {
                            ai_sdk_provider?: "anthropic" | "openai" | "openai-compatible" | "openrouter" | undefined;
                            family?: "gemini" | "claude" | "gpt" | "llama" | "mistral" | undefined;
                            prompt?: "codex" | "gemini" | "beast" | "anthropic" | "trinity" | "anthropic_without_todo" | undefined;
                            variants?: Record<string, {
                                verbosity?: "high" | "medium" | "low" | "max" | undefined;
                                reasoning?: {
                                    enabled?: boolean | undefined;
                                    effort?: "high" | "medium" | "low" | "none" | "xhigh" | undefined;
                                } | undefined;
                            }> | undefined;
                        } | undefined;
                        per_request_limits?: Record<string, unknown> | null | undefined;
                        supported_parameters?: string[] | undefined;
                    }[];
                };
                meta: object;
            }>;
            updateAllowLists: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    model_deny_list?: string[] | undefined;
                    provider_deny_list?: string[] | undefined;
                };
                output: {
                    settings: {
                        model_allow_list?: string[] | undefined;
                        provider_allow_list?: string[] | undefined;
                        model_deny_list?: string[] | undefined;
                        provider_deny_list?: string[] | undefined;
                        default_model?: string | undefined;
                        data_collection?: "allow" | "deny" | null | undefined;
                        enable_usage_limits?: boolean | undefined;
                        code_indexing_enabled?: boolean | undefined;
                        projects_ui_enabled?: boolean | undefined;
                        minimum_balance?: number | undefined;
                        minimum_balance_alert_email?: string[] | undefined;
                        suppress_trial_messaging?: boolean | undefined;
                        oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                        github_app_type?: "standard" | "lite" | null | undefined;
                        oss_monthly_credit_amount_microdollars?: number | null | undefined;
                        oss_credits_last_reset_at?: string | null | undefined;
                        oss_github_url?: string | null | undefined;
                    };
                };
                meta: object;
            }>;
            updateDefaultModel: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    default_model: string | null;
                };
                output: {
                    settings: {
                        model_allow_list?: string[] | undefined;
                        provider_allow_list?: string[] | undefined;
                        model_deny_list?: string[] | undefined;
                        provider_deny_list?: string[] | undefined;
                        default_model?: string | undefined;
                        data_collection?: "allow" | "deny" | null | undefined;
                        enable_usage_limits?: boolean | undefined;
                        code_indexing_enabled?: boolean | undefined;
                        projects_ui_enabled?: boolean | undefined;
                        minimum_balance?: number | undefined;
                        minimum_balance_alert_email?: string[] | undefined;
                        suppress_trial_messaging?: boolean | undefined;
                        oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                        github_app_type?: "standard" | "lite" | null | undefined;
                        oss_monthly_credit_amount_microdollars?: number | null | undefined;
                        oss_credits_last_reset_at?: string | null | undefined;
                        oss_github_url?: string | null | undefined;
                    };
                };
                meta: object;
            }>;
            updateDataCollection: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    dataCollection: "allow" | "deny" | null;
                };
                output: {
                    settings: {
                        model_allow_list?: string[] | undefined;
                        provider_allow_list?: string[] | undefined;
                        model_deny_list?: string[] | undefined;
                        provider_deny_list?: string[] | undefined;
                        default_model?: string | undefined;
                        data_collection?: "allow" | "deny" | null | undefined;
                        enable_usage_limits?: boolean | undefined;
                        code_indexing_enabled?: boolean | undefined;
                        projects_ui_enabled?: boolean | undefined;
                        minimum_balance?: number | undefined;
                        minimum_balance_alert_email?: string[] | undefined;
                        suppress_trial_messaging?: boolean | undefined;
                        oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                        github_app_type?: "standard" | "lite" | null | undefined;
                        oss_monthly_credit_amount_microdollars?: number | null | undefined;
                        oss_credits_last_reset_at?: string | null | undefined;
                        oss_github_url?: string | null | undefined;
                    };
                };
                meta: object;
            }>;
            updateProjectsUIEnabled: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projects_ui_enabled: boolean;
                };
                output: {
                    settings: {
                        model_allow_list?: string[] | undefined;
                        provider_allow_list?: string[] | undefined;
                        model_deny_list?: string[] | undefined;
                        provider_deny_list?: string[] | undefined;
                        default_model?: string | undefined;
                        data_collection?: "allow" | "deny" | null | undefined;
                        enable_usage_limits?: boolean | undefined;
                        code_indexing_enabled?: boolean | undefined;
                        projects_ui_enabled?: boolean | undefined;
                        minimum_balance?: number | undefined;
                        minimum_balance_alert_email?: string[] | undefined;
                        suppress_trial_messaging?: boolean | undefined;
                        oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                        github_app_type?: "standard" | "lite" | null | undefined;
                        oss_monthly_credit_amount_microdollars?: number | null | undefined;
                        oss_credits_last_reset_at?: string | null | undefined;
                        oss_github_url?: string | null | undefined;
                    };
                };
                meta: object;
            }>;
            updateCodeIndexingFeatureFlag: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    code_indexing_enabled: boolean;
                };
                output: {
                    settings: {
                        model_allow_list?: string[] | undefined;
                        provider_allow_list?: string[] | undefined;
                        model_deny_list?: string[] | undefined;
                        provider_deny_list?: string[] | undefined;
                        default_model?: string | undefined;
                        data_collection?: "allow" | "deny" | null | undefined;
                        enable_usage_limits?: boolean | undefined;
                        code_indexing_enabled?: boolean | undefined;
                        projects_ui_enabled?: boolean | undefined;
                        minimum_balance?: number | undefined;
                        minimum_balance_alert_email?: string[] | undefined;
                        suppress_trial_messaging?: boolean | undefined;
                        oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                        github_app_type?: "standard" | "lite" | null | undefined;
                        oss_monthly_credit_amount_microdollars?: number | null | undefined;
                        oss_credits_last_reset_at?: string | null | undefined;
                        oss_github_url?: string | null | undefined;
                    };
                };
                meta: object;
            }>;
            updateMinimumBalanceAlert: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    enabled: boolean;
                    minimum_balance?: number | undefined;
                    minimum_balance_alert_email?: string[] | undefined;
                };
                output: {
                    settings: {
                        model_allow_list?: string[] | undefined;
                        provider_allow_list?: string[] | undefined;
                        model_deny_list?: string[] | undefined;
                        provider_deny_list?: string[] | undefined;
                        default_model?: string | undefined;
                        data_collection?: "allow" | "deny" | null | undefined;
                        enable_usage_limits?: boolean | undefined;
                        code_indexing_enabled?: boolean | undefined;
                        projects_ui_enabled?: boolean | undefined;
                        minimum_balance?: number | undefined;
                        minimum_balance_alert_email?: string[] | undefined;
                        suppress_trial_messaging?: boolean | undefined;
                        oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                        github_app_type?: "standard" | "lite" | null | undefined;
                        oss_monthly_credit_amount_microdollars?: number | null | undefined;
                        oss_credits_last_reset_at?: string | null | undefined;
                        oss_github_url?: string | null | undefined;
                    };
                };
                meta: object;
            }>;
        }>>;
        usageDetails: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getTimeSeries: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    startDate: string;
                    endDate: string;
                };
                output: {
                    timeseries: {
                        datetime: string;
                        name: string;
                        email: string;
                        model: string;
                        provider: string;
                        projectId: string | null;
                        costMicrodollars: number;
                        inputTokenCount: number;
                        outputTokenCount: number;
                        requestCount: number;
                    }[];
                };
                meta: object;
            }>;
            get: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    period?: "all" | "year" | "month" | "week" | undefined;
                    userFilter?: "all" | "me" | undefined;
                    groupByModel?: boolean | undefined;
                };
                output: {
                    daily: {
                        date: string;
                        user: {
                            name: string;
                            email: string;
                        };
                        microdollarCost: string | null;
                        tokenCount: number;
                        inputTokens: number;
                        outputTokens: number;
                        requestCount: number;
                        model?: string | undefined;
                    }[];
                };
                meta: object;
            }>;
            getAutocomplete: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    period?: "all" | "year" | "month" | "week" | undefined;
                };
                output: {
                    cost: number;
                    requests: number;
                    tokens: number;
                };
                meta: object;
            }>;
            getAIAdoptionTimeseries: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    startDate: string;
                    endDate: string;
                };
                output: {
                    timeseries: {
                        datetime: string;
                        frequency: number;
                        depth: number;
                        coverage: number;
                    }[];
                    weeklyTrends: {
                        frequency: {
                            change: number;
                            trend: "up" | "down" | "neutral";
                        };
                        depth: {
                            change: number;
                            trend: "up" | "down" | "neutral";
                        };
                        coverage: {
                            change: number;
                            trend: "up" | "down" | "neutral";
                        };
                        total: {
                            change: number;
                            trend: "up" | "down" | "neutral";
                        };
                    } | null;
                    userScores: {
                        frequency: number;
                        depth: number;
                        coverage: number;
                        total: number;
                    }[];
                    isNewOrganization: boolean;
                };
                meta: object;
            }>;
        }>>;
        sso: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            createConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                };
                output: _workos_inc_node.Organization;
                meta: object;
            }>;
            getConfig: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: false | {
                    isDomainVerified: boolean;
                    hasConnection: boolean;
                    object: "organization";
                    id: string;
                    name: string;
                    allowProfilesOutsideOrganization: boolean;
                    domains: _workos_inc_node.OrganizationDomain[];
                    stripeCustomerId?: string;
                    createdAt: string;
                    updatedAt: string;
                    externalId: string | null;
                    metadata: Record<string, string>;
                };
                meta: object;
            }>;
            deleteConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                };
                output: SuccessResult<{
                    message: string;
                }>;
                meta: object;
            }>;
            generateAdminPortalLink: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    linkType: "sso" | "domain-verification";
                };
                output: {
                    link: string;
                };
                meta: object;
            }>;
            updateSsoDomain: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    ssoDomain: string;
                };
                output: SuccessResult<{
                    message: string;
                }>;
                meta: object;
            }>;
            clearSsoDomain: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                };
                output: SuccessResult<{
                    message: string;
                }>;
                meta: object;
            }>;
        }>>;
        auditLogs: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    before?: string | undefined;
                    after?: string | undefined;
                    action?: ("organization.user.login" | "organization.user.logout" | "organization.user.accept_invite" | "organization.user.send_invite" | "organization.user.revoke_invite" | "organization.settings.change" | "organization.purchase_credits" | "organization.promo_credit_granted" | "organization.member.remove" | "organization.member.change_role" | "organization.sso.auto_provision" | "organization.sso.set_domain" | "organization.sso.remove_domain" | "organization.mode.create" | "organization.mode.update" | "organization.mode.delete" | "organization.created" | "organization.token.generate")[] | undefined;
                    actorEmail?: string | undefined;
                    fuzzySearch?: string | undefined;
                    startTime?: string | undefined;
                    endTime?: string | undefined;
                };
                output: {
                    logs: {
                        id: string;
                        action: string;
                        actor_id: string | null;
                        actor_email: string | null;
                        actor_name: string | null;
                        message: string;
                        created_at: string;
                    }[];
                    hasNext: boolean;
                    hasPrevious: boolean;
                    oldestTimestamp: string | null;
                    newestTimestamp: string | null;
                };
                meta: object;
            }>;
            getActionTypes: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: ("organization.user.login" | "organization.user.logout" | "organization.user.accept_invite" | "organization.user.send_invite" | "organization.user.revoke_invite" | "organization.settings.change" | "organization.purchase_credits" | "organization.promo_credit_granted" | "organization.member.remove" | "organization.member.change_role" | "organization.sso.auto_provision" | "organization.sso.set_domain" | "organization.sso.remove_domain" | "organization.mode.create" | "organization.mode.update" | "organization.mode.delete" | "organization.created" | "organization.token.generate")[];
                meta: object;
            }>;
            getSummary: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    totalEvents: number;
                    earliestEvent: string | null;
                    latestEvent: string | null;
                };
                meta: object;
            }>;
        }>>;
        admin: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            create: _trpc_server.TRPCMutationProcedure<{
                input: {
                    name: string;
                };
                output: {
                    organization: {
                        id: string;
                        name: string;
                        updated_at: string;
                        created_at: string;
                        microdollars_used: number;
                        stripe_customer_id: string | null;
                        total_microdollars_acquired: number;
                        next_credit_expiration_at: string | null;
                        auto_top_up_enabled: boolean;
                        deleted_at: string | null;
                        microdollars_balance: number;
                        settings: {
                            model_allow_list?: string[] | undefined;
                            provider_allow_list?: string[] | undefined;
                            model_deny_list?: string[] | undefined;
                            provider_deny_list?: string[] | undefined;
                            default_model?: string | undefined;
                            data_collection?: "allow" | "deny" | null | undefined;
                            enable_usage_limits?: boolean | undefined;
                            code_indexing_enabled?: boolean | undefined;
                            projects_ui_enabled?: boolean | undefined;
                            minimum_balance?: number | undefined;
                            minimum_balance_alert_email?: string[] | undefined;
                            suppress_trial_messaging?: boolean | undefined;
                            oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                            github_app_type?: "standard" | "lite" | null | undefined;
                            oss_monthly_credit_amount_microdollars?: number | null | undefined;
                            oss_credits_last_reset_at?: string | null | undefined;
                            oss_github_url?: string | null | undefined;
                        };
                        seat_count: number;
                        require_seats: boolean;
                        created_by_kilo_user_id: string | null;
                        sso_domain: string | null;
                        plan: "teams" | "enterprise";
                        free_trial_end_at: string | null;
                        company_domain: string | null;
                    };
                };
                meta: object;
            }>;
            updateCreatedBy: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    userId: string | null;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            updateFreeTrialEndAt: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    free_trial_end_at: string | null;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            updateSuppressTrialMessaging: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    suppress_trial_messaging: boolean;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            getDetails: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    id: string;
                    name: string;
                    created_at: string;
                    updated_at: string;
                    total_microdollars_acquired: number;
                    microdollars_used: number;
                    created_by_kilo_user_id: string | null;
                    created_by_user_email: string | null;
                    created_by_user_name: string | null;
                };
                meta: object;
            }>;
            grantCredit: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    amount_usd: number;
                    description?: string | undefined;
                    expiry_date?: string | null | undefined;
                    expiry_hours?: number | null | undefined;
                };
                output: {
                    message: string;
                    amount_usd: number;
                };
                meta: object;
            }>;
            nullifyCredits: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    description?: string | undefined;
                };
                output: {
                    message: string;
                    amount_usd_nullified: number;
                };
                meta: object;
            }>;
            getMetrics: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: {
                    teamCount: number;
                    teamMemberCount: number;
                    enterpriseCount: number;
                    enterpriseMemberCount: number;
                    trialingTeamCount: number;
                    trialingTeamMemberCount: number;
                    trialingEnterpriseCount: number;
                    trialingEnterpriseMemberCount: number;
                };
                meta: object;
            }>;
            addMember: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    userId: string;
                    role: "owner" | "member" | "billing_manager";
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            delete: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    page?: number | undefined;
                    limit?: number | undefined;
                    sortBy?: "name" | "created_at" | "microdollars_used" | "balance" | "member_count" | undefined;
                    sortOrder?: "asc" | "desc" | undefined;
                    search?: string | undefined;
                    seatsRequired?: "" | "true" | "false" | undefined;
                    hasBalance?: "" | "true" | "false" | undefined;
                    status?: "active" | "all" | "incomplete" | "deleted" | undefined;
                    plan?: "" | "teams" | "enterprise" | undefined;
                };
                output: {
                    organizations: {
                        id: string;
                        name: string;
                        created_at: string;
                        updated_at: string;
                        microdollars_used: number;
                        total_microdollars_acquired: number;
                        next_credit_expiration_at: string | null;
                        stripe_customer_id: string | null;
                        auto_top_up_enabled: boolean;
                        settings: {
                            model_allow_list?: string[] | undefined;
                            provider_allow_list?: string[] | undefined;
                            model_deny_list?: string[] | undefined;
                            provider_deny_list?: string[] | undefined;
                            default_model?: string | undefined;
                            data_collection?: "allow" | "deny" | null | undefined;
                            enable_usage_limits?: boolean | undefined;
                            code_indexing_enabled?: boolean | undefined;
                            projects_ui_enabled?: boolean | undefined;
                            minimum_balance?: number | undefined;
                            minimum_balance_alert_email?: string[] | undefined;
                            suppress_trial_messaging?: boolean | undefined;
                            oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                            github_app_type?: "standard" | "lite" | null | undefined;
                            oss_monthly_credit_amount_microdollars?: number | null | undefined;
                            oss_credits_last_reset_at?: string | null | undefined;
                            oss_github_url?: string | null | undefined;
                        };
                        seat_count: number;
                        require_seats: boolean;
                        created_by_kilo_user_id: string | null;
                        deleted_at: string | null;
                        sso_domain: string | null;
                        plan: "teams" | "enterprise";
                        free_trial_end_at: string | null;
                        company_domain: string | null;
                        member_count: number;
                        created_by_user_email: string | null;
                        created_by_user_name: string | null;
                        subscription_amount_usd: number | null;
                    }[];
                    pagination: {
                        page: number;
                        limit: number;
                        total: number;
                        totalPages: number;
                    };
                };
                meta: object;
            }>;
            search: _trpc_server.TRPCQueryProcedure<{
                input: {
                    search: string;
                    limit?: number | undefined;
                };
                output: {
                    id: string;
                    name: string;
                }[];
                meta: object;
            }>;
        }>>;
        modes: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            create: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    name: string;
                    slug: string;
                    config?: {
                        roleDefinition?: string | undefined;
                        whenToUse?: string | undefined;
                        description?: string | undefined;
                        customInstructions?: string | undefined;
                        groups?: ("read" | "edit" | "browser" | "command" | "mcp" | ["edit", {
                            fileRegex: string;
                            description?: string | undefined;
                        }])[] | undefined;
                    } | undefined;
                };
                output: {
                    mode: {
                        id: string;
                        name: string;
                        slug: string;
                        updated_at: string;
                        created_at: string;
                        organization_id: string;
                        created_by: string;
                        config: Partial<{
                            roleDefinition: string;
                            groups: ("read" | "edit" | "browser" | "command" | "mcp" | ["edit", {
                                fileRegex: string;
                                description?: string | undefined;
                            }])[];
                            whenToUse?: string | undefined;
                            description?: string | undefined;
                            customInstructions?: string | undefined;
                        }>;
                    };
                };
                meta: object;
            }>;
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    modes: {
                        id: string;
                        name: string;
                        slug: string;
                        updated_at: string;
                        created_at: string;
                        organization_id: string;
                        created_by: string;
                        config: Partial<{
                            roleDefinition: string;
                            groups: ("read" | "edit" | "browser" | "command" | "mcp" | ["edit", {
                                fileRegex: string;
                                description?: string | undefined;
                            }])[];
                            whenToUse?: string | undefined;
                            description?: string | undefined;
                            customInstructions?: string | undefined;
                        }>;
                    }[];
                };
                meta: object;
            }>;
            getById: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    modeId: string;
                };
                output: {
                    mode: {
                        id: string;
                        name: string;
                        slug: string;
                        updated_at: string;
                        created_at: string;
                        organization_id: string;
                        created_by: string;
                        config: Partial<{
                            roleDefinition: string;
                            groups: ("read" | "edit" | "browser" | "command" | "mcp" | ["edit", {
                                fileRegex: string;
                                description?: string | undefined;
                            }])[];
                            whenToUse?: string | undefined;
                            description?: string | undefined;
                            customInstructions?: string | undefined;
                        }>;
                    };
                };
                meta: object;
            }>;
            update: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    modeId: string;
                    name?: string | undefined;
                    slug?: string | undefined;
                    config?: {
                        roleDefinition?: string | undefined;
                        whenToUse?: string | undefined;
                        description?: string | undefined;
                        customInstructions?: string | undefined;
                        groups?: ("read" | "edit" | "browser" | "command" | "mcp" | ["edit", {
                            fileRegex: string;
                            description?: string | undefined;
                        }])[] | undefined;
                    } | undefined;
                };
                output: {
                    mode: {
                        id: string;
                        name: string;
                        slug: string;
                        updated_at: string;
                        created_at: string;
                        organization_id: string;
                        created_by: string;
                        config: Partial<{
                            roleDefinition: string;
                            groups: ("read" | "edit" | "browser" | "command" | "mcp" | ["edit", {
                                fileRegex: string;
                                description?: string | undefined;
                            }])[];
                            whenToUse?: string | undefined;
                            description?: string | undefined;
                            customInstructions?: string | undefined;
                        }>;
                    };
                };
                meta: object;
            }>;
            delete: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    modeId: string;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
        }>>;
        deployments: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            checkDeploymentEligibility: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    canCreateDeployment: boolean;
                };
                meta: object;
            }>;
            listDeployments: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    success: boolean;
                    data: {
                        deployment: {
                            id: string;
                            created_by_user_id: string | null;
                            owned_by_user_id: string | null;
                            owned_by_organization_id: string | null;
                            deployment_slug: string;
                            internal_worker_name: string;
                            repository_source: string;
                            branch: string;
                            deployment_url: string;
                            platform_integration_id: string | null;
                            source_type: "github" | "git" | "app-builder";
                            git_auth_token: string | null;
                            created_at: string;
                            last_deployed_at: string | null;
                            last_build_id: string;
                            threat_status: "pending_scan" | "safe" | "flagged" | null;
                            created_from: "app-builder" | "deploy" | null;
                        };
                        latestBuild: {
                            id: string;
                            deployment_id: string;
                            status: "failed" | "queued" | "building" | "deploying" | "deployed" | "cancelled";
                            started_at: string | null;
                            completed_at: string | null;
                            created_at: string;
                        } | null;
                        appBuilderProjectId: string | null;
                    }[];
                };
                meta: object;
            }>;
            getDeployment: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    id: string;
                };
                output: {
                    success: boolean;
                    deployment: {
                        id: string;
                        created_by_user_id: string | null;
                        owned_by_user_id: string | null;
                        owned_by_organization_id: string | null;
                        deployment_slug: string;
                        internal_worker_name: string;
                        repository_source: string;
                        branch: string;
                        deployment_url: string;
                        platform_integration_id: string | null;
                        source_type: "github" | "git" | "app-builder";
                        git_auth_token: string | null;
                        created_at: string;
                        last_deployed_at: string | null;
                        last_build_id: string;
                        threat_status: "pending_scan" | "safe" | "flagged" | null;
                        created_from: "app-builder" | "deploy" | null;
                    };
                    latestBuild: {
                        id: string;
                        deployment_id: string;
                        status: "failed" | "queued" | "building" | "deploying" | "deployed" | "cancelled";
                        started_at: string | null;
                        completed_at: string | null;
                        created_at: string;
                    } | null;
                    appBuilderProjectId: string | null;
                };
                meta: object;
            }>;
            getBuildEvents: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                    buildId: string;
                    limit?: number | undefined;
                    afterEventId?: number | undefined;
                };
                output: ({
                    id: number;
                    ts: string;
                    type: "log";
                    payload: {
                        message: string;
                    };
                } | {
                    id: number;
                    ts: string;
                    type: "status_change";
                    payload: {
                        status: "failed" | "queued" | "building" | "deploying" | "deployed" | "cancelled";
                    };
                })[];
                meta: object;
            }>;
            deleteDeployment: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    id: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            cancelBuild: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                    buildId: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            redeploy: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    id: string;
                };
                output: void;
                meta: object;
            }>;
            createDeployment: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    platformIntegrationId: string;
                    repositoryFullName: string;
                    branch: string;
                    envVars?: {
                        key: string;
                        value: string;
                        isSecret: boolean;
                    }[] | undefined;
                };
                output: CreateDeploymentResult;
                meta: object;
            }>;
            checkSlugAvailability: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    slug: string;
                };
                output: CheckSlugAvailabilityResult;
                meta: object;
            }>;
            renameDeployment: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                    newSlug: string;
                };
                output: RenameDeploymentResult;
                meta: object;
            }>;
            setEnvVar: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    key: string;
                    value: string;
                    isSecret: boolean;
                    deploymentId: string;
                };
                output: void;
                meta: object;
            }>;
            deleteEnvVar: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                    key: string;
                };
                output: void;
                meta: object;
            }>;
            listEnvVars: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                };
                output: {
                    key: string;
                    value: string;
                    isSecret: boolean;
                    createdAt: string;
                    updatedAt: string;
                }[];
                meta: object;
            }>;
            renameEnvVar: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                    oldKey: string;
                    newKey: string;
                };
                output: void;
                meta: object;
            }>;
            getPasswordStatus: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                };
                output: {
                    protected: true;
                    passwordSetAt: number;
                } | {
                    protected: false;
                };
                meta: object;
            }>;
            setPassword: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                    password: string;
                };
                output: {
                    success: true;
                    passwordSetAt: number;
                };
                meta: object;
            }>;
            removePassword: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    deploymentId: string;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
        }>>;
        reviewAgent: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getGitHubStatus: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    connected: boolean;
                    integration: null;
                } | {
                    connected: boolean;
                    integration: {
                        accountLogin: string | null;
                        repositorySelection: string | null;
                        installedAt: string;
                        isValid: boolean;
                    };
                };
                meta: object;
            }>;
            listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    forceRefresh?: boolean | undefined;
                };
                output: {
                    integrationInstalled: boolean;
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                    }[];
                    syncedAt?: string | null;
                    errorMessage?: string;
                };
                meta: object;
            }>;
            getGitLabStatus: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    connected: boolean;
                    integration: null;
                } | {
                    connected: boolean;
                    integration: {
                        accountLogin: string | null;
                        repositorySelection: string | null;
                        installedAt: string;
                        isValid: boolean;
                        webhookSecret: string | undefined;
                        instanceUrl: string;
                    };
                };
                meta: object;
            }>;
            listGitLabRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    forceRefresh?: boolean | undefined;
                };
                output: {
                    integrationInstalled: boolean;
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                    }[];
                    syncedAt?: string | null;
                    errorMessage?: string;
                    instanceUrl?: string;
                };
                meta: object;
            }>;
            searchGitLabRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    query: string;
                };
                output: {
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                    }[];
                    errorMessage?: string;
                };
                meta: object;
            }>;
            getReviewConfig: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    platform?: "github" | "gitlab" | undefined;
                };
                output: {
                    isEnabled: boolean;
                    reviewStyle: "strict" | "balanced" | "lenient" | "roast";
                    focusAreas: string[];
                    customInstructions: string | null;
                    maxReviewTimeMinutes: number;
                    modelSlug: string;
                    thinkingEffort: string | null;
                    gateThreshold: "all" | "off" | "warning" | "critical";
                    repositorySelectionMode: "all" | "selected";
                    selectedRepositoryIds: number[];
                    manuallyAddedRepositories: {
                        id: number;
                        name: string;
                        full_name: string;
                        private: boolean;
                    }[];
                    isCloudAgentNextEnabled: boolean;
                    isPrGateEnabled: boolean;
                };
                meta: object;
            }>;
            saveReviewConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    reviewStyle: "strict" | "balanced" | "lenient" | "roast";
                    focusAreas: string[];
                    maxReviewTimeMinutes: number;
                    modelSlug: string;
                    platform?: "github" | "gitlab" | undefined;
                    customInstructions?: string | undefined;
                    thinkingEffort?: string | null | undefined;
                    repositorySelectionMode?: "all" | "selected" | undefined;
                    selectedRepositoryIds?: number[] | undefined;
                    manuallyAddedRepositories?: {
                        id: number;
                        name: string;
                        full_name: string;
                        private: boolean;
                    }[] | undefined;
                    gateThreshold?: "all" | "off" | "warning" | "critical" | undefined;
                    autoConfigureWebhooks?: boolean | undefined;
                };
                output: {
                    success: boolean;
                    webhookSync: {
                        created: number;
                        updated: number;
                        deleted: number;
                        errors: {
                            projectId: number;
                            error: string;
                            operation: "create" | "update" | "delete";
                        }[];
                    } | {
                        created: number;
                        updated: number;
                        deleted: number;
                        errors: {
                            projectId: number;
                            error: string;
                            operation: "sync";
                        }[];
                    } | null;
                };
                meta: object;
            }>;
            toggleReviewAgent: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    isEnabled: boolean;
                    platform?: "github" | "gitlab" | undefined;
                };
                output: {
                    success: boolean;
                    isEnabled: boolean;
                };
                meta: object;
            }>;
        }>>;
        cloudAgent: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            initiateSessionStream: _trpc_server.TRPCSubscriptionProcedure<{
                input: {
                    organizationId: string;
                    githubRepo: string;
                    prompt: string;
                    mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                    model: string;
                    variant?: string | undefined;
                    envVars?: Record<string, string> | undefined;
                    setupCommands?: string[] | undefined;
                    mcpServers?: Record<string, {
                        command: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        type?: "stdio" | undefined;
                        args?: string[] | undefined;
                        cwd?: string | undefined;
                        env?: Record<string, string> | undefined;
                    } | {
                        type: "sse";
                        url: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        headers?: Record<string, string> | undefined;
                    } | {
                        type: "streamable-http";
                        url: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        headers?: Record<string, string> | undefined;
                    }> | undefined;
                    upstreamBranch?: string | undefined;
                    autoCommit?: boolean | undefined;
                };
                output: AsyncIterable<StreamEvent, void, any>;
                meta: object;
            }>;
            initiateFromKilocodeSessionStream: _trpc_server.TRPCSubscriptionProcedure<{
                input: {
                    organizationId: string;
                    kiloSessionId: string;
                    githubRepo: string;
                    prompt: string;
                    mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                    model: string;
                    envVars?: Record<string, string> | undefined;
                    setupCommands?: string[] | undefined;
                    autoCommit?: boolean | undefined;
                } | {
                    organizationId: string;
                    cloudAgentSessionId: string;
                };
                output: AsyncIterable<StreamEvent, void, any>;
                meta: object;
            }>;
            prepareSession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    prompt: string;
                    mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                    model: string;
                    githubRepo?: string | undefined;
                    gitlabProject?: string | undefined;
                    variant?: string | undefined;
                    profileName?: string | undefined;
                    envVars?: Record<string, string> | undefined;
                    setupCommands?: string[] | undefined;
                    mcpServers?: Record<string, {
                        command: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        type?: "stdio" | undefined;
                        args?: string[] | undefined;
                        cwd?: string | undefined;
                        env?: Record<string, string> | undefined;
                    } | {
                        type: "sse";
                        url: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        headers?: Record<string, string> | undefined;
                    } | {
                        type: "streamable-http";
                        url: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        headers?: Record<string, string> | undefined;
                    }> | undefined;
                    upstreamBranch?: string | undefined;
                    autoCommit?: boolean | undefined;
                };
                output: {
                    kiloSessionId: string;
                    cloudAgentSessionId: string;
                };
                meta: object;
            }>;
            prepareLegacySession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    prompt: string;
                    mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                    model: string;
                    cloudAgentSessionId: string;
                    kiloSessionId: string;
                    githubRepo?: string | undefined;
                    gitlabProject?: string | undefined;
                    variant?: string | undefined;
                    profileName?: string | undefined;
                    envVars?: Record<string, string> | undefined;
                    setupCommands?: string[] | undefined;
                    mcpServers?: Record<string, {
                        command: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        type?: "stdio" | undefined;
                        args?: string[] | undefined;
                        cwd?: string | undefined;
                        env?: Record<string, string> | undefined;
                    } | {
                        type: "sse";
                        url: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        headers?: Record<string, string> | undefined;
                    } | {
                        type: "streamable-http";
                        url: string;
                        disabled?: boolean | undefined;
                        timeout?: number | undefined;
                        alwaysAllow?: string[] | undefined;
                        watchPaths?: string[] | undefined;
                        disabledTools?: string[] | undefined;
                        headers?: Record<string, string> | undefined;
                    }> | undefined;
                    upstreamBranch?: string | undefined;
                    autoCommit?: boolean | undefined;
                };
                output: {
                    kiloSessionId: string;
                    cloudAgentSessionId: string;
                };
                meta: object;
            }>;
            sendMessageStream: _trpc_server.TRPCSubscriptionProcedure<{
                input: {
                    organizationId: string;
                    sessionId: string;
                    prompt: string;
                    mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                    model: string;
                    variant?: string | undefined;
                    autoCommit?: boolean | undefined;
                };
                output: AsyncIterable<StreamEvent, void, any>;
                meta: object;
            }>;
            listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    forceRefresh?: boolean | undefined;
                };
                output: {
                    integrationInstalled: boolean;
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                    }[];
                    syncedAt?: string | null;
                    errorMessage?: string;
                };
                meta: object;
            }>;
            listGitLabRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    forceRefresh?: boolean | undefined;
                };
                output: {
                    integrationInstalled: boolean;
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                    }[];
                    syncedAt?: string | null;
                    errorMessage?: string;
                    instanceUrl?: string;
                };
                meta: object;
            }>;
            deleteSession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    sessionId: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            interruptSession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    sessionId: string;
                };
                output: InterruptResult;
                meta: object;
            }>;
            getSession: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    cloudAgentSessionId: string;
                };
                output: {
                    sessionId: string;
                    userId: string;
                    timestamp: number;
                    version: number;
                    kiloSessionId?: string | undefined;
                    orgId?: string | undefined;
                    sandboxId?: string | undefined;
                    githubRepo?: string | undefined;
                    gitUrl?: string | undefined;
                    prompt?: string | undefined;
                    mode?: "code" | "architect" | "ask" | "debug" | "orchestrator" | undefined;
                    model?: string | undefined;
                    autoCommit?: boolean | undefined;
                    condenseOnComplete?: boolean | undefined;
                    upstreamBranch?: string | undefined;
                    envVarCount?: number | undefined;
                    setupCommandCount?: number | undefined;
                    mcpServerCount?: number | undefined;
                    execution?: {
                        id: string;
                        status: "failed" | "completed" | "interrupted" | "pending" | "running";
                        startedAt?: number | undefined;
                        lastHeartbeat?: number | null | undefined;
                        processId?: string | null | undefined;
                        error?: string | null | undefined;
                        health?: "unknown" | "stale" | "healthy" | undefined;
                    } | null | undefined;
                    queuedCount?: number | undefined;
                    preparedAt?: number | undefined;
                    initiatedAt?: number | undefined;
                };
                meta: object;
            }>;
            checkEligibility: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    balance: number;
                    minBalance: number;
                    isEligible: boolean;
                };
                meta: object;
            }>;
            initiateFromKilocodeSessionV2: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    kiloSessionId: string;
                    githubRepo: string;
                    prompt: string;
                    mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                    model: string;
                    envVars?: Record<string, string> | undefined;
                    setupCommands?: string[] | undefined;
                    autoCommit?: boolean | undefined;
                } | {
                    organizationId: string;
                    cloudAgentSessionId: string;
                };
                output: {
                    cloudAgentSessionId: string;
                    executionId: string;
                    status: "queued" | "started";
                    streamUrl: string;
                };
                meta: object;
            }>;
            sendMessageV2: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    cloudAgentSessionId: string;
                    prompt: string;
                    mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                    model: string;
                    variant?: string | undefined;
                    autoCommit?: boolean | undefined;
                };
                output: {
                    cloudAgentSessionId: string;
                    executionId: string;
                    status: "queued" | "started";
                    streamUrl: string;
                };
                meta: object;
            }>;
        }>>;
        cloudAgentNext: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            prepareSession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    prompt: string;
                    mode: "custom" | "plan" | "code" | "architect" | "ask" | "debug" | "orchestrator" | "build";
                    model: string;
                    githubRepo?: string | undefined;
                    gitlabProject?: string | undefined;
                    variant?: string | undefined;
                    profileName?: string | undefined;
                    envVars?: Record<string, string> | undefined;
                    setupCommands?: string[] | undefined;
                    mcpServers?: Record<string, {
                        type: "local";
                        command: string[];
                        environment?: Record<string, string> | undefined;
                        enabled?: boolean | undefined;
                        timeout?: number | undefined;
                    } | {
                        type: "remote";
                        url: string;
                        headers?: Record<string, string> | undefined;
                        enabled?: boolean | undefined;
                        timeout?: number | undefined;
                    }> | undefined;
                    upstreamBranch?: string | undefined;
                    autoCommit?: boolean | undefined;
                    autoInitiate?: boolean | undefined;
                };
                output: {
                    kiloSessionId: string;
                    cloudAgentSessionId: string;
                };
                meta: object;
            }>;
            initiateFromPreparedSession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    cloudAgentSessionId: string;
                };
                output: {
                    cloudAgentSessionId: string;
                    executionId: string;
                    status: "started";
                    streamUrl: string;
                };
                meta: object;
            }>;
            sendMessage: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    cloudAgentSessionId: string;
                    prompt: string;
                    mode: "plan" | "code" | "ask" | "debug" | "orchestrator";
                    model: string;
                    variant?: string | undefined;
                    autoCommit?: boolean | undefined;
                };
                output: {
                    cloudAgentSessionId: string;
                    executionId: string;
                    status: "started";
                    streamUrl: string;
                };
                meta: object;
            }>;
            interruptSession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    sessionId: string;
                };
                output: {
                    success: boolean;
                    message: string;
                    processesFound: boolean;
                };
                meta: object;
            }>;
            answerQuestion: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    sessionId: string;
                    questionId: string;
                    answers: string[][];
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            rejectQuestion: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    sessionId: string;
                    questionId: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            getSession: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    cloudAgentSessionId: string;
                };
                output: {
                    sessionId: string;
                    userId: string;
                    execution: {
                        id: string;
                        status: "failed" | "completed" | "interrupted" | "pending" | "running";
                        startedAt: number;
                        lastHeartbeat: number | null;
                        processId: string | null;
                        error: string | null;
                        health: "unknown" | "stale" | "healthy";
                    } | null;
                    timestamp: number;
                    version: number;
                    kiloSessionId?: string | undefined;
                    orgId?: string | undefined;
                    sandboxId?: string | undefined;
                    githubRepo?: string | undefined;
                    gitUrl?: string | undefined;
                    platform?: "github" | "gitlab" | undefined;
                    prompt?: string | undefined;
                    mode?: "custom" | "plan" | "code" | "architect" | "ask" | "debug" | "orchestrator" | "build" | undefined;
                    model?: string | undefined;
                    autoCommit?: boolean | undefined;
                    upstreamBranch?: string | undefined;
                    envVarCount?: number | undefined;
                    setupCommandCount?: number | undefined;
                    mcpServerCount?: number | undefined;
                    preparedAt?: number | undefined;
                    initiatedAt?: number | undefined;
                    callbackTarget?: {
                        url: string;
                        headers?: Record<string, string> | undefined;
                    } | undefined;
                };
                meta: object;
            }>;
            listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    forceRefresh?: boolean | undefined;
                };
                output: {
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                        defaultBranch?: string | undefined;
                    }[];
                    integrationInstalled: boolean;
                    syncedAt?: string | null | undefined;
                    errorMessage?: string | undefined;
                };
                meta: object;
            }>;
            listGitLabRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    forceRefresh?: boolean | undefined;
                };
                output: {
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                    }[];
                    integrationInstalled: boolean;
                    syncedAt?: string | null | undefined;
                    errorMessage?: string | undefined;
                };
                meta: object;
            }>;
        }>>;
        appBuilder: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            createProject: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    prompt: string;
                    model: string;
                    title?: string | undefined;
                    images?: {
                        path: string;
                        files: string[];
                    } | undefined;
                    template?: "resume" | "startup-landing-page" | undefined;
                    mode?: "code" | "ask" | undefined;
                };
                output: CreateProjectResult;
                meta: object;
            }>;
            getPreviewUrl: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: {
                    status: string;
                    previewUrl: string | null;
                };
                meta: object;
            }>;
            triggerBuild: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            getProject: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: ProjectWithMessages;
                meta: object;
            }>;
            listProjects: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    id: string;
                    updated_at: string;
                    created_at: string;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    created_by_user_id: string | null;
                    session_id: string | null;
                    deployment_id: string | null;
                    title: string;
                    model_id: string;
                    template: string | null;
                    last_message_at: string | null;
                    git_repo_full_name: string | null;
                    git_platform_integration_id: string | null;
                    migrated_at: string | null;
                }[];
                meta: object;
            }>;
            listUserProjects: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    id: string;
                    updated_at: string;
                    created_at: string;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    created_by_user_id: string | null;
                    session_id: string | null;
                    deployment_id: string | null;
                    title: string;
                    model_id: string;
                    template: string | null;
                    last_message_at: string | null;
                    git_repo_full_name: string | null;
                    git_platform_integration_id: string | null;
                    migrated_at: string | null;
                }[];
                meta: object;
            }>;
            deployProject: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: DeployProjectResult;
                meta: object;
            }>;
            checkEligibility: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    balance: number;
                    minBalance: number;
                    accessLevel: "full" | "limited";
                    isEligible: boolean;
                };
                meta: object;
            }>;
            generateCloneToken: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: {
                    token: string;
                    gitUrl: string;
                    expiresAt: string;
                };
                meta: object;
            }>;
            deleteProject: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            interruptSession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            getImageUploadUrl: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    messageUuid: string;
                    imageId: string;
                    contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                    contentLength: number;
                };
                output: GenerateImageUploadUrlResult;
                meta: object;
            }>;
            startSession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: {
                    cloudAgentSessionId: string;
                };
                meta: object;
            }>;
            sendMessage: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                    message: string;
                    images?: {
                        path: string;
                        files: string[];
                    } | undefined;
                    model?: string | undefined;
                };
                output: {
                    cloudAgentSessionId: string;
                    workerVersion: WorkerVersion;
                };
                meta: object;
            }>;
            prepareLegacySession: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                    model: string;
                    prompt: string;
                };
                output: {
                    cloudAgentSessionId: string;
                };
                meta: object;
            }>;
            canMigrateToGitHub: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                };
                output: CanMigrateToGitHubResult;
                meta: object;
            }>;
            migrateToGitHub: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    projectId: string;
                    repoFullName: string;
                };
                output: MigrateToGitHubResult;
                meta: object;
            }>;
        }>>;
        securityAgent: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getPermissionStatus: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    hasIntegration: boolean;
                    hasPermissions: boolean;
                    reauthorizeUrl: string | null;
                };
                meta: object;
            }>;
            getConfig: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    isEnabled: boolean;
                    slaCriticalDays: number;
                    slaHighDays: number;
                    slaMediumDays: number;
                    slaLowDays: number;
                    autoSyncEnabled: boolean;
                    repositorySelectionMode: "all" | "selected";
                    selectedRepositoryIds: number[];
                    modelSlug: string;
                    triageModelSlug: string;
                    analysisModelSlug: string;
                    analysisMode: "auto" | "deep" | "shallow";
                    autoDismissEnabled: boolean;
                    autoDismissConfidenceThreshold: "high" | "medium" | "low";
                    autoAnalysisEnabled: boolean;
                    autoAnalysisMinSeverity: "all" | "critical" | "high" | "medium";
                    autoAnalysisIncludeExisting: boolean;
                };
                meta: object;
            }>;
            saveConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    slaCriticalDays?: number | undefined;
                    slaHighDays?: number | undefined;
                    slaMediumDays?: number | undefined;
                    slaLowDays?: number | undefined;
                    autoSyncEnabled?: boolean | undefined;
                    repositorySelectionMode?: "all" | "selected" | undefined;
                    selectedRepositoryIds?: number[] | undefined;
                    modelSlug?: string | undefined;
                    triageModelSlug?: string | undefined;
                    analysisModelSlug?: string | undefined;
                    analysisMode?: "auto" | "deep" | "shallow" | undefined;
                    autoDismissEnabled?: boolean | undefined;
                    autoDismissConfidenceThreshold?: "high" | "medium" | "low" | undefined;
                    autoAnalysisEnabled?: boolean | undefined;
                    autoAnalysisMinSeverity?: "all" | "critical" | "high" | "medium" | undefined;
                    autoAnalysisIncludeExisting?: boolean | undefined;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            setEnabled: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    isEnabled: boolean;
                    repositorySelectionMode?: "all" | "selected" | undefined;
                    selectedRepositoryIds?: number[] | undefined;
                };
                output: {
                    success: boolean;
                    syncResult: {
                        synced: number;
                        errors: number;
                    };
                } | {
                    success: boolean;
                    syncResult?: undefined;
                };
                meta: object;
            }>;
            getRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    id: number;
                    fullName: string;
                    name: string;
                    private: boolean;
                }[];
                meta: object;
            }>;
            listFindings: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    repoFullName?: string | undefined;
                    status?: "open" | "fixed" | "closed" | "ignored" | undefined;
                    severity?: "critical" | "high" | "medium" | "low" | undefined;
                    outcomeFilter?: "failed" | "all" | "fixed" | "dismissed" | "analyzing" | "not_analyzed" | "exploitable" | "not_exploitable" | "safe_to_dismiss" | "needs_review" | "triage_complete" | undefined;
                    overdue?: boolean | undefined;
                    sortBy?: "severity_desc" | "severity_asc" | "sla_due_at_asc" | undefined;
                    limit?: number | undefined;
                    offset?: number | undefined;
                };
                output: {
                    findings: {
                        description: string | null;
                        id: string;
                        updated_at: string;
                        created_at: string;
                        status: string;
                        source: string;
                        owned_by_user_id: string | null;
                        owned_by_organization_id: string | null;
                        session_id: string | null;
                        platform_integration_id: string | null;
                        repo_full_name: string;
                        cli_session_id: string | null;
                        title: string;
                        source_id: string;
                        severity: string;
                        ghsa_id: string | null;
                        cve_id: string | null;
                        package_name: string;
                        package_ecosystem: string;
                        vulnerable_version_range: string | null;
                        patched_version: string | null;
                        manifest_path: string | null;
                        ignored_reason: string | null;
                        ignored_by: string | null;
                        fixed_at: string | null;
                        sla_due_at: string | null;
                        dependabot_html_url: string | null;
                        cwe_ids: string[] | null;
                        cvss_score: string | null;
                        dependency_scope: string | null;
                        analysis_status: string | null;
                        analysis_started_at: string | null;
                        analysis_completed_at: string | null;
                        analysis_error: string | null;
                        analysis: SecurityFindingAnalysis | null;
                        raw_data: DependabotAlertRaw | null;
                        first_detected_at: string;
                        last_synced_at: string;
                    }[];
                    totalCount: number;
                    runningCount: number;
                    concurrencyLimit: number;
                };
                meta: object;
            }>;
            getFinding: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    id: string;
                };
                output: {
                    description: string | null;
                    id: string;
                    updated_at: string;
                    created_at: string;
                    status: string;
                    source: string;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    session_id: string | null;
                    platform_integration_id: string | null;
                    repo_full_name: string;
                    cli_session_id: string | null;
                    title: string;
                    source_id: string;
                    severity: string;
                    ghsa_id: string | null;
                    cve_id: string | null;
                    package_name: string;
                    package_ecosystem: string;
                    vulnerable_version_range: string | null;
                    patched_version: string | null;
                    manifest_path: string | null;
                    ignored_reason: string | null;
                    ignored_by: string | null;
                    fixed_at: string | null;
                    sla_due_at: string | null;
                    dependabot_html_url: string | null;
                    cwe_ids: string[] | null;
                    cvss_score: string | null;
                    dependency_scope: string | null;
                    analysis_status: string | null;
                    analysis_started_at: string | null;
                    analysis_completed_at: string | null;
                    analysis_error: string | null;
                    analysis: SecurityFindingAnalysis | null;
                    raw_data: DependabotAlertRaw | null;
                    first_detected_at: string;
                    last_synced_at: string;
                };
                meta: object;
            }>;
            getStats: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    total: number;
                    critical: number;
                    high: number;
                    medium: number;
                    low: number;
                    open: number;
                    fixed: number;
                    ignored: number;
                };
                meta: object;
            }>;
            getDashboardStats: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    repoFullName?: string | undefined;
                };
                output: DashboardStats;
                meta: object;
            }>;
            getLastSyncTime: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    repoFullName?: string | undefined;
                };
                output: {
                    lastSyncTime: string | null;
                };
                meta: object;
            }>;
            triggerSync: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    repoFullName?: string | undefined;
                };
                output: {
                    success: boolean;
                    synced: number;
                    errors: number;
                };
                meta: object;
            }>;
            dismissFinding: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    findingId: string;
                    reason: "fix_started" | "inaccurate" | "no_bandwidth" | "not_used" | "tolerable_risk";
                    comment?: string | undefined;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            startAnalysis: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    findingId: string;
                    model?: string | undefined;
                    triageModel?: string | undefined;
                    analysisModel?: string | undefined;
                    retrySandboxOnly?: boolean | undefined;
                };
                output: {
                    success: boolean;
                    triageOnly: boolean | undefined;
                };
                meta: object;
            }>;
            getAnalysis: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    findingId: string;
                };
                output: {
                    status: string | null;
                    startedAt: string | null;
                    completedAt: string | null;
                    error: string | null;
                    analysis: SecurityFindingAnalysis | null;
                    sessionId: string | null;
                    cliSessionId: string | null;
                };
                meta: object;
            }>;
            getOrphanedRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    repoFullName: string;
                    findingCount: number;
                }[];
                meta: object;
            }>;
            deleteFindingsByRepository: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    repoFullName: string;
                };
                output: {
                    success: boolean;
                    deletedCount: number;
                };
                meta: object;
            }>;
            getAutoDismissEligible: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    eligible: number;
                    byConfidence: {
                        high: number;
                        medium: number;
                        low: number;
                    };
                };
                meta: object;
            }>;
            autoDismissEligible: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    dismissed: number;
                    skipped: number;
                    errors: number;
                };
                meta: object;
            }>;
        }>>;
        securityAuditLog: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    before?: string | undefined;
                    after?: string | undefined;
                    action?: SecurityAuditLogAction[] | undefined;
                    actorEmail?: string | undefined;
                    resourceType?: string | undefined;
                    resourceId?: string | undefined;
                    fuzzySearch?: string | undefined;
                    startTime?: string | undefined;
                    endTime?: string | undefined;
                };
                output: {
                    logs: {
                        id: string;
                        action: SecurityAuditLogAction;
                        actor_id: string | null;
                        actor_email: string | null;
                        actor_name: string | null;
                        resource_type: string;
                        resource_id: string;
                        before_state: Record<string, unknown> | null;
                        after_state: Record<string, unknown> | null;
                        metadata: Record<string, unknown> | null;
                        created_at: string;
                    }[];
                    hasNext: boolean;
                    hasPrevious: boolean;
                    oldestTimestamp: string | null;
                    newestTimestamp: string | null;
                };
                meta: object;
            }>;
            getActionTypes: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: SecurityAuditLogAction[];
                meta: object;
            }>;
            getSummary: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    totalEvents: number;
                    earliestEvent: string | null;
                    latestEvent: string | null;
                };
                meta: object;
            }>;
            export: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    format?: "json" | "csv" | undefined;
                    startTime?: string | undefined;
                    endTime?: string | undefined;
                    action?: SecurityAuditLogAction[] | undefined;
                };
                output: {
                    format: "csv";
                    data: string;
                    rowCount: number;
                } | {
                    format: "json";
                    data: string;
                    rowCount: number;
                };
                meta: object;
            }>;
        }>>;
        autoTriage: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getGitHubStatus: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    connected: boolean;
                    integration: null;
                } | {
                    connected: boolean;
                    integration: {
                        accountLogin: string | null;
                        repositorySelection: string | null;
                        installedAt: string | Date | null;
                        isValid: boolean;
                    };
                };
                meta: object;
            }>;
            listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    integrationInstalled: boolean;
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                    }[];
                    errorMessage?: string;
                };
                meta: object;
            }>;
            getAutoTriageConfig: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    isEnabled: boolean;
                    enabled_for_issues: boolean;
                    repository_selection_mode: "all" | "selected";
                    selected_repository_ids: number[];
                    skip_labels: string[];
                    required_labels: string[];
                    duplicate_threshold: number;
                    auto_fix_threshold: number;
                    auto_create_pr_threshold: number;
                    max_concurrent_per_owner: number;
                    custom_instructions: string | null;
                    model_slug: string;
                    max_classification_time_minutes: number;
                    max_pr_creation_time_minutes: number;
                };
                meta: object;
            }>;
            saveAutoTriageConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    enabled_for_issues: boolean;
                    repository_selection_mode: "all" | "selected";
                    selected_repository_ids?: number[] | undefined;
                    skip_labels?: string[] | undefined;
                    required_labels?: string[] | undefined;
                    duplicate_threshold?: number | undefined;
                    auto_fix_threshold?: number | undefined;
                    auto_create_pr_threshold?: number | undefined;
                    max_concurrent_per_owner?: number | undefined;
                    custom_instructions?: string | null | undefined;
                    model_slug?: string | undefined;
                    pr_branch_prefix?: string | undefined;
                    pr_title_template?: string | undefined;
                    pr_body_template?: string | undefined;
                    pr_base_branch?: string | undefined;
                    max_classification_time_minutes?: number | undefined;
                    max_pr_creation_time_minutes?: number | undefined;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            toggleAutoTriageAgent: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    isEnabled: boolean;
                };
                output: {
                    success: boolean;
                    isEnabled: boolean;
                };
                meta: object;
            }>;
            retryTicket: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    ticketId: string;
                };
                output: SuccessResult<{
                    ticketId: string;
                }>;
                meta: object;
            }>;
            interruptTicket: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    ticketId: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            listTickets: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    limit?: number | undefined;
                    offset?: number | undefined;
                    status?: "failed" | "pending" | "analyzing" | "actioned" | "skipped" | undefined;
                    classification?: "feature" | "bug" | "question" | "duplicate" | "unclear" | undefined;
                    repoFullName?: string | undefined;
                };
                output: FailureResult<string> | SuccessResult<{
                    tickets: {
                        id: string;
                        updated_at: string;
                        created_at: string;
                        status: "failed" | "pending" | "analyzing" | "actioned" | "skipped";
                        started_at: string | null;
                        owned_by_user_id: string | null;
                        owned_by_organization_id: string | null;
                        session_id: string | null;
                        platform: string;
                        platform_integration_id: string | null;
                        completed_at: string | null;
                        repo_full_name: string;
                        error_message: string | null;
                        issue_number: number;
                        issue_url: string;
                        issue_title: string;
                        issue_body: string | null;
                        issue_author: string;
                        issue_type: "issue" | "pull_request";
                        issue_labels: string[] | null;
                        classification: "feature" | "bug" | "question" | "duplicate" | "unclear" | null;
                        confidence: string | null;
                        intent_summary: string | null;
                        related_files: string[] | null;
                        is_duplicate: boolean | null;
                        duplicate_of_ticket_id: string | null;
                        similarity_score: string | null;
                        qdrant_point_id: string | null;
                        should_auto_fix: boolean | null;
                        action_taken: "pr_created" | "comment_posted" | "closed_duplicate" | "needs_clarification" | null;
                        action_metadata: unknown;
                    }[];
                    total: number;
                    hasMore: boolean;
                }>;
                meta: object;
            }>;
        }>>;
        autoFix: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    integrationInstalled: boolean;
                    repositories: {
                        id: number;
                        name: string;
                        fullName: string;
                        private: boolean;
                    }[];
                    syncedAt?: string | null;
                    errorMessage?: string;
                };
                meta: object;
            }>;
            getAutoFixConfig: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    enabled_for_issues: boolean;
                    enabled_for_review_comments: boolean;
                    repository_selection_mode: "all" | "selected";
                    selected_repository_ids: number[];
                    skip_labels: string[];
                    required_labels: string[];
                    model_slug: string;
                    pr_title_template: string;
                    pr_base_branch: string;
                    max_pr_creation_time_minutes: number;
                    max_concurrent_per_owner: number;
                    custom_instructions?: string | null | undefined;
                    pr_body_template?: string | null | undefined;
                    isEnabled: boolean;
                };
                meta: object;
            }>;
            saveAutoFixConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    [x: string]: unknown;
                    organizationId: string;
                    enabled_for_issues: boolean;
                    repository_selection_mode: "all" | "selected";
                    enabled_for_review_comments?: boolean | undefined;
                    selected_repository_ids?: number[] | undefined;
                    skip_labels?: string[] | undefined;
                    required_labels?: string[] | undefined;
                    model_slug?: string | undefined;
                    custom_instructions?: string | null | undefined;
                    pr_title_template?: string | undefined;
                    pr_body_template?: string | null | undefined;
                    pr_base_branch?: string | undefined;
                    max_pr_creation_time_minutes?: number | undefined;
                };
                output: {
                    success: boolean;
                    message: string;
                };
                meta: object;
            }>;
            toggleAutoFixAgent: _trpc_server.TRPCMutationProcedure<{
                input: {
                    [x: string]: unknown;
                    organizationId: string;
                    isEnabled: boolean;
                };
                output: {
                    success: boolean;
                    message: string;
                    isEnabled: boolean;
                };
                meta: object;
            }>;
            listTickets: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                    limit?: number | undefined;
                    offset?: number | undefined;
                    status?: "failed" | "completed" | "cancelled" | "pending" | "running" | undefined;
                    classification?: "feature" | "bug" | "question" | "unclear" | undefined;
                    repoFullName?: string | undefined;
                };
                output: FailureResult<string> | SuccessResult<ListFixTicketsResponse>;
                meta: object;
            }>;
            retriggerFix: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    ticketId: string;
                };
                output: FailureResult<string> | SuccessResult<{
                    message: string;
                }>;
                meta: object;
            }>;
            cancelFix: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    ticketId: string;
                };
                output: FailureResult<string> | SuccessResult<{
                    message: string;
                }>;
                meta: object;
            }>;
        }>>;
        autoTopUp: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getConfig: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    enabled: boolean;
                    amountCents: 10000 | 50000 | 100000;
                    paymentMethod: {
                        type: stripe.Stripe.PaymentMethod.Type;
                        last4: string | null;
                        brand: string | null;
                        linkEmail: string | null;
                        stripePaymentMethodId: string;
                    } | null;
                };
                meta: object;
            }>;
            toggle: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    currentEnabled: boolean;
                    amountCents?: 10000 | 50000 | 100000 | undefined;
                };
                output: {
                    readonly enabled: false;
                    readonly redirectUrl?: undefined;
                } | {
                    readonly enabled: true;
                    readonly redirectUrl?: undefined;
                } | {
                    readonly enabled: false;
                    readonly redirectUrl: string;
                };
                meta: object;
            }>;
            changePaymentMethod: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    amountCents?: 10000 | 50000 | 100000 | undefined;
                };
                output: {
                    redirectUrl: string;
                };
                meta: object;
            }>;
            updateAmount: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    amountCents: 10000 | 50000 | 100000;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            removePaymentMethod: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
        }>>;
        list: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: UserOrganizationWithSeats[];
            meta: object;
        }>;
        create: _trpc_server.TRPCMutationProcedure<{
            input: {
                name: string;
                autoAddCreator?: boolean | undefined;
                plan?: "teams" | "enterprise" | undefined;
                company_domain?: string | undefined;
            };
            output: {
                organization: {
                    id: string;
                    name: string;
                    updated_at: string;
                    created_at: string;
                    microdollars_used: number;
                    stripe_customer_id: string | null;
                    total_microdollars_acquired: number;
                    next_credit_expiration_at: string | null;
                    auto_top_up_enabled: boolean;
                    deleted_at: string | null;
                    microdollars_balance: number;
                    settings: {
                        model_allow_list?: string[] | undefined;
                        provider_allow_list?: string[] | undefined;
                        model_deny_list?: string[] | undefined;
                        provider_deny_list?: string[] | undefined;
                        default_model?: string | undefined;
                        data_collection?: "allow" | "deny" | null | undefined;
                        enable_usage_limits?: boolean | undefined;
                        code_indexing_enabled?: boolean | undefined;
                        projects_ui_enabled?: boolean | undefined;
                        minimum_balance?: number | undefined;
                        minimum_balance_alert_email?: string[] | undefined;
                        suppress_trial_messaging?: boolean | undefined;
                        oss_sponsorship_tier?: 1 | 2 | 3 | null | undefined;
                        github_app_type?: "standard" | "lite" | null | undefined;
                        oss_monthly_credit_amount_microdollars?: number | null | undefined;
                        oss_credits_last_reset_at?: string | null | undefined;
                        oss_github_url?: string | null | undefined;
                    };
                    seat_count: number;
                    require_seats: boolean;
                    created_by_kilo_user_id: string | null;
                    sso_domain: string | null;
                    plan: "teams" | "enterprise";
                    free_trial_end_at: string | null;
                    company_domain: string | null;
                };
            };
            meta: object;
        }>;
        updateCompanyDomain: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId: string;
                company_domain: string | null;
            };
            output: {
                success: true;
            };
            meta: object;
        }>;
        withMembers: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
            };
            output: OrganizationWithMembers;
            meta: object;
        }>;
        update: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId: string;
                name: string;
            };
            output: {
                organization: {
                    id: string;
                    name: string;
                };
            };
            meta: object;
        }>;
        updatePlan: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId: string;
                plan: "teams" | "enterprise";
            };
            output: {
                organization: {
                    id: string;
                    plan: "teams" | "enterprise";
                };
            };
            meta: object;
        }>;
        updateSeatsRequired: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId: string;
                seatsRequired: boolean;
            };
            output: {
                organization: {
                    id: string;
                    require_seats: boolean;
                };
            };
            meta: object;
        }>;
        usageStats: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
            };
            output: {
                totalCost: number;
                totalRequestCount: number;
                totalInputTokens: number;
                totalOutputTokens: number;
            };
            meta: object;
        }>;
        creditTransactions: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
            };
            output: {
                description: string | null;
                id: string;
                created_at: string;
                is_free: boolean;
                kilo_user_id: string;
                amount_microdollars: number;
                expiration_baseline_microdollars_used: number | null;
                original_baseline_microdollars_used: number | null;
                original_transaction_id: string | null;
                stripe_payment_id: string | null;
                coinbase_credit_block_id: string | null;
                credit_category: string | null;
                expiry_date: string | null;
                organization_id: string | null;
                check_category_uniqueness: boolean;
            }[];
            meta: object;
        }>;
        getCreditBlocks: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
            };
            output: {
                creditBlocks: {
                    id: string;
                    effective_date: string;
                    expiry_date: string | null;
                    balance_mUsd: number;
                    amount_mUsd: number;
                    is_free: boolean;
                }[];
                totalBalance_mUsd: number;
                isFirstPurchase: boolean;
            };
            meta: object;
        }>;
        seats: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
            };
            output: {
                totalSeats: number;
                usedSeats: number;
            };
            meta: object;
        }>;
        seatPurchases: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
            };
            output: {
                seatPurchases: {
                    id: string;
                    organization_id: string;
                    subscription_stripe_id: string;
                    seat_count: number;
                    amount_usd: number;
                    created_at: string;
                    expires_at: string;
                    updated_at: string;
                    subscription_status: "active" | "pending_cancel" | "ended";
                    idempotency_key: string;
                    starts_at: string;
                    billing_cycle: BillingCycle;
                }[];
            };
            meta: object;
        }>;
        invoices: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
                period?: "all" | "year" | "month" | "week" | undefined;
            };
            output: UnifiedInvoice[];
            meta: object;
        }>;
    }>>;
    debug: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        badInputError: _trpc_server.TRPCQueryProcedure<{
            input: string;
            output: string;
            meta: object;
        }>;
        unhandledError: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: never;
            meta: object;
        }>;
        handledTrpcError: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: never;
            meta: object;
        }>;
        badInputObjectError: _trpc_server.TRPCQueryProcedure<{
            input: {
                name: string;
                age: number;
            };
            output: string;
            meta: object;
        }>;
    }>>;
    user: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        getAuthProviders: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: SuccessResult<{
                providers: {
                    provider: AuthProviderId;
                    email: string;
                    avatar_url: string;
                    hosted_domain: string | null;
                    created_at: string;
                }[];
            }>;
            meta: object;
        }>;
        linkAuthProvider: _trpc_server.TRPCMutationProcedure<{
            input: {
                provider: "email" | "google" | "github" | "gitlab" | "linkedin" | "discord" | "fake-login" | "workos";
            };
            output: {
                success: true;
            };
            meta: object;
        }>;
        unlinkAuthProvider: _trpc_server.TRPCMutationProcedure<{
            input: {
                provider: "email" | "google" | "github" | "gitlab" | "linkedin" | "discord" | "fake-login" | "workos";
            };
            output: {
                success: true;
            };
            meta: object;
        }>;
        resetAPIKey: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: true;
            };
            meta: object;
        }>;
        getCreditBlocks: _trpc_server.TRPCQueryProcedure<{
            input: Record<string, never>;
            output: {
                creditBlocks: {
                    id: string;
                    effective_date: string;
                    expiry_date: string | null;
                    balance_mUsd: number;
                    amount_mUsd: number;
                    is_free: boolean;
                }[];
                totalBalance_mUsd: number;
                isFirstPurchase: boolean;
                autoTopUpEnabled: boolean;
            };
            meta: object;
        }>;
        getBalance: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                balance: number;
                isDepleted: boolean;
            };
            meta: object;
        }>;
        getContextBalance: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            };
            output: {
                balance: number;
                isDepleted: boolean;
            };
            meta: object;
        }>;
        getAutocompleteMetrics: _trpc_server.TRPCQueryProcedure<{
            input: {
                viewType?: string | undefined;
                period?: "all" | "year" | "month" | "week" | undefined;
            };
            output: {
                cost: number;
                requests: number;
                tokens: number;
            };
            meta: object;
        }>;
        toggleAutoTopUp: _trpc_server.TRPCMutationProcedure<{
            input: {
                currentEnabled: boolean;
                amountCents?: 5000 | 10000 | 2000 | undefined;
            };
            output: {
                readonly enabled: false;
                readonly redirectUrl?: undefined;
            } | {
                readonly enabled: true;
                readonly redirectUrl?: undefined;
            } | {
                readonly enabled: false;
                readonly redirectUrl: string;
            };
            meta: object;
        }>;
        changeAutoTopUpPaymentMethod: _trpc_server.TRPCMutationProcedure<{
            input: {
                amountCents?: number | undefined;
            } | undefined;
            output: {
                redirectUrl: string;
            };
            meta: object;
        }>;
        getAutoTopUpPaymentMethod: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                enabled: boolean;
                amountCents: 5000 | 10000 | 2000;
                paymentMethod: {
                    type: stripe.Stripe.PaymentMethod.Type;
                    last4: string | null;
                    brand: string | null;
                    linkEmail: string | null;
                    stripePaymentMethodId: string;
                } | null;
            };
            meta: object;
        }>;
        updateAutoTopUpAmount: _trpc_server.TRPCMutationProcedure<{
            input: {
                amountCents: 5000 | 10000 | 2000;
            };
            output: {
                success: true;
            };
            meta: object;
        }>;
        removeAutoTopUpPaymentMethod: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: true;
            };
            meta: object;
        }>;
        markWelcomeFormCompleted: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: true;
            };
            meta: object;
        }>;
        submitCustomerSource: _trpc_server.TRPCMutationProcedure<{
            input: {
                source: string;
            };
            output: {
                success: true;
            };
            meta: object;
        }>;
        skipCustomerSource: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: true;
            };
            meta: object;
        }>;
        updateProfile: _trpc_server.TRPCMutationProcedure<{
            input: {
                linkedin_url?: string | null | undefined;
                github_url?: string | null | undefined;
            };
            output: {
                success: true;
            };
            meta: object;
        }>;
        getDiscordGuildStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: SuccessResult<{
                linked: boolean;
                discord_avatar_url: string | null;
                discord_display_name: string | null;
                discord_server_membership_verified_at: string | null;
            }>;
            meta: object;
        }>;
        verifyDiscordGuildMembership: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: SuccessResult<{
                is_member: boolean;
            }>;
            meta: object;
        }>;
    }>>;
    admin: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        webhookTriggers: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    scope: "user";
                    userId: string;
                } | {
                    scope: "organization";
                    organizationId: string;
                };
                output: {
                    inboundUrl: string;
                    id: string;
                    triggerId: string;
                    githubRepo: string;
                    isActive: boolean;
                    createdAt: string;
                    updatedAt: string;
                }[];
                meta: object;
            }>;
            get: _trpc_server.TRPCQueryProcedure<{
                input: ({
                    scope: "user";
                    userId: string;
                } | {
                    scope: "organization";
                    organizationId: string;
                }) & {
                    triggerId: string;
                };
                output: {
                    inboundUrl: string;
                    triggerId: string;
                    namespace: string;
                    userId: string | null;
                    orgId: string | null;
                    createdAt: string;
                    isActive: boolean;
                    githubRepo: string;
                    mode: string;
                    model: string;
                    promptTemplate: string;
                    profileId?: string | null;
                    autoCommit?: boolean;
                    condenseOnComplete?: boolean;
                    webhookAuthHeader?: string;
                    webhookAuthConfigured: boolean;
                };
                meta: object;
            }>;
            listRequests: _trpc_server.TRPCQueryProcedure<{
                input: (({
                    scope: "user";
                    userId: string;
                } | {
                    scope: "organization";
                    organizationId: string;
                }) & {
                    triggerId: string;
                }) & {
                    limit?: number | undefined;
                };
                output: EnrichedCapturedRequest[];
                meta: object;
            }>;
        }>>;
        github: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getKilocodeOpenPullRequestCounts: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: OpenPullRequestCounts;
                meta: object;
            }>;
            getKilocodeOpenPullRequestsSummary: _trpc_server.TRPCQueryProcedure<{
                input: {
                    includeDrafts?: boolean | undefined;
                    repos?: ("cloud" | "kilocode" | "kilo-marketplace" | "kilocode-legacy")[] | undefined;
                } | undefined;
                output: OpenPullRequestsSummary;
                meta: object;
            }>;
            getKilocodeRecentlyMergedExternalPRs: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: ExternalMergedPullRequest[];
                meta: object;
            }>;
            getKilocodeRecentlyClosedExternalPRs: _trpc_server.TRPCQueryProcedure<{
                input: {
                    repos?: ("cloud" | "kilocode" | "kilo-marketplace" | "kilocode-legacy")[] | undefined;
                } | undefined;
                output: ExternalClosedPullRequestsWithWeekStats;
                meta: object;
            }>;
        }>>;
        users: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            addNote: _trpc_server.TRPCMutationProcedure<{
                input: {
                    kilo_user_id: string;
                    noteContent: string;
                };
                output: {
                    admin_kilo_user: {
                        default_model: string | null;
                        id: string;
                        updated_at: string;
                        created_at: string;
                        google_user_email: string;
                        google_user_name: string;
                        google_user_image_url: string;
                        hosted_domain: string | null;
                        microdollars_used: number;
                        kilo_pass_threshold: number | null;
                        stripe_customer_id: string;
                        is_admin: boolean;
                        total_microdollars_acquired: number;
                        next_credit_expiration_at: string | null;
                        has_validation_stytch: boolean | null;
                        has_validation_novel_card_with_hold: boolean;
                        blocked_reason: string | null;
                        api_token_pepper: string | null;
                        auto_top_up_enabled: boolean;
                        is_bot: boolean;
                        cohorts: Record<string, number>;
                        completed_welcome_form: boolean;
                        linkedin_url: string | null;
                        github_url: string | null;
                        discord_server_membership_verified_at: string | null;
                        openrouter_upstream_safety_identifier: string | null;
                        customer_source: string | null;
                    };
                    id: string;
                    created_at: string;
                    kilo_user_id: string;
                    note_content: string;
                    admin_kilo_user_id: string | null;
                };
                meta: object;
            }>;
            deleteNote: _trpc_server.TRPCMutationProcedure<{
                input: {
                    note_id: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            resetAPIKey: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            checkKiloPass: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    before: {
                        microdollars_used: number;
                        kilo_pass_threshold: number | null;
                    };
                    after: {
                        microdollars_used: number;
                        kilo_pass_threshold: number | null;
                    } | undefined;
                };
                meta: object;
            }>;
            resetToMagicLinkLogin: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            updateBlockStatus: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                    blocked_reason: string | null;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            getStytchFingerprints: _trpc_server.TRPCQueryProcedure<{
                input: {
                    kilo_user_id: string;
                    fingerprint_type?: "visitor_fingerprint" | "browser_fingerprint" | "hardware_fingerprint" | "network_fingerprint" | undefined;
                };
                output: {
                    fingerprints: {
                        id: string;
                        visitor_fingerprint: string;
                        browser_fingerprint: string;
                        network_fingerprint: string;
                        hardware_fingerprint: string;
                        kilo_user_id: string;
                        verdict_action: string;
                        kilo_free_tier_allowed: boolean;
                        created_at: string;
                        reasons: string[];
                    }[];
                    relatedUsers: {
                        google_user_email: string;
                        google_user_name: string;
                        google_user_image_url: string;
                        has_validation_stytch: boolean | null;
                        user_created_at: string;
                        id: string;
                        visitor_fingerprint: string;
                        browser_fingerprint: string;
                        network_fingerprint: string;
                        hardware_fingerprint: string;
                        kilo_user_id: string;
                        verdict_action: string;
                        kilo_free_tier_allowed: boolean;
                        created_at: string;
                        reasons: string[];
                    }[];
                    fingerprintType: "visitor_fingerprint" | "browser_fingerprint" | "hardware_fingerprint" | "network_fingerprint";
                };
                meta: object;
            }>;
            getKiloPassState: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    subscription: null;
                    issuances: never[];
                    currentPeriodUsageUsd: null;
                    thresholds: null;
                } | {
                    subscription: {
                        subscriptionId: string;
                        stripeSubscriptionId: string;
                        tier: KiloPassTier;
                        cadence: KiloPassCadence;
                        status: stripe.Stripe.Subscription.Status;
                        cancelAtPeriodEnd: boolean;
                        currentStreakMonths: number;
                        nextYearlyIssueAt: string | null;
                        startedAt: string | null;
                    };
                    issuances: {
                        issueMonth: string;
                        issuanceCreatedAt: string;
                        itemKind: KiloPassIssuanceItemKind;
                        itemAmountUsd: number;
                        itemCreatedAt: string;
                        bonusPercentApplied: number | null;
                    }[];
                    currentPeriodUsageUsd: number | null;
                    thresholds: {
                        kiloPassThreshold_mUsd: number | null;
                        effectiveThreshold_mUsd: number | null;
                        microdollarsUsed: number;
                        totalMicrodollarsAcquired: number;
                        bonusUnlocked: boolean;
                    };
                };
                meta: object;
            }>;
            getKiloClawState: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    subscription: {
                        id: string;
                        updated_at: string;
                        created_at: string;
                        stripe_subscription_id: string | null;
                        status: KiloClawSubscriptionStatus;
                        cancel_at_period_end: boolean;
                        stripe_schedule_id: string | null;
                        plan: KiloClawPlan;
                        user_id: string;
                        suspended_at: string | null;
                        scheduled_plan: KiloClawScheduledPlan | null;
                        scheduled_by: KiloClawScheduledBy | null;
                        trial_started_at: string | null;
                        trial_ends_at: string | null;
                        current_period_start: string | null;
                        current_period_end: string | null;
                        commit_ends_at: string | null;
                        past_due_since: string | null;
                        destruction_deadline: string | null;
                    } | null;
                    hasAccess: boolean;
                    accessReason: "trial" | "subscription" | "earlybird" | null;
                    earlybird: {
                        purchased: boolean;
                        expiresAt: string;
                        daysRemaining: number;
                    } | null;
                    activeInstanceId: string | null;
                };
                meta: object;
            }>;
            updateKiloClawTrialEndAt: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                    trial_ends_at: string;
                };
                output: {
                    success: true;
                };
                meta: object;
            }>;
            getInvoices: _trpc_server.TRPCQueryProcedure<{
                input: {
                    stripe_customer_id: string;
                };
                output: {
                    invoices: UnifiedInvoice[];
                };
                meta: object;
            }>;
            recomputeBalances: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                    dryRun?: boolean | undefined;
                };
                output: SuccessResult<UserBalanceUpdates>;
                meta: object;
            }>;
            DEV_ONLY_messUpBalance: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            cancelAndRefundKiloPass: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                    reason: string;
                };
                output: {
                    success: boolean;
                    refundedAmountCents: number | null;
                    balanceResetAmountUsd: number | null;
                    alreadyBlocked: boolean;
                };
                meta: object;
            }>;
        }>>;
        enrichmentData: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            upsert: _trpc_server.TRPCMutationProcedure<{
                input: {
                    user_id: string;
                    github_enrichment_data?: Record<string, unknown> | null | undefined;
                    linkedin_enrichment_data?: Record<string, unknown> | null | undefined;
                    clay_enrichment_data?: Record<string, unknown> | null | undefined;
                };
                output: SuccessResult<{
                    data: {
                        id: string;
                        updated_at: string;
                        created_at: string;
                        user_id: string;
                        github_enrichment_data: unknown;
                        linkedin_enrichment_data: unknown;
                        clay_enrichment_data: unknown;
                    };
                }>;
                meta: object;
            }>;
        }>>;
        modelStats: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    page?: number | undefined;
                    limit?: number | undefined;
                    sortBy?: "name" | "isActive" | "openrouterId" | "createdAt" | undefined;
                    sortOrder?: "asc" | "desc" | undefined;
                    search?: string | undefined;
                    isActive?: "" | "true" | "false" | undefined;
                };
                output: {
                    models: {
                        id: string;
                        isActive: boolean | null;
                        isFeatured: boolean;
                        isStealth: boolean;
                        openrouterId: string;
                        slug: string | null;
                        aaSlug: string | null;
                        name: string;
                        description: string | null;
                        modelCreator: string | null;
                        creatorSlug: string | null;
                        releaseDate: string | null;
                        priceInput: string | null;
                        priceOutput: string | null;
                        codingIndex: string | null;
                        speedTokensPerSec: string | null;
                        contextLength: number | null;
                        maxOutputTokens: number | null;
                        inputModalities: string[] | null;
                        openrouterData: {
                            slug: string;
                            hf_slug: string | null;
                            updated_at: string;
                            created_at: string;
                            hf_updated_at: string | null;
                            name: string;
                            short_name: string;
                            author: string;
                            description: string;
                            model_version_group_id: string | null;
                            context_length: number;
                            input_modalities: string[];
                            output_modalities: string[];
                            has_text_output: boolean;
                            group: string;
                            instruct_type: string | null;
                            default_system: string | null;
                            default_stops: string[];
                            hidden: boolean;
                            router: string | null;
                            warning_message: string | null;
                            permaslug: string;
                            reasoning_config: {
                                start_token?: string | null | undefined;
                                end_token?: string | null | undefined;
                                system_prompt?: string | null | undefined;
                            } | null;
                            features: {
                                [x: string]: unknown;
                                reasoning_config?: {
                                    start_token?: string | null | undefined;
                                    end_token?: string | null | undefined;
                                    system_prompt?: string | null | undefined;
                                } | undefined;
                                supports_implicit_caching?: boolean | undefined;
                                supports_file_urls?: boolean | undefined;
                                supports_input_audio?: boolean | undefined;
                                supports_tool_choice?: {
                                    literal_none: boolean;
                                    literal_auto: boolean;
                                    literal_required: boolean;
                                    type_function: boolean;
                                } | undefined;
                                supported_parameters?: {
                                    [x: string]: unknown;
                                    response_format?: boolean | undefined;
                                    structured_outputs?: boolean | undefined;
                                } | undefined;
                            } | null;
                            default_parameters: Record<string, unknown> | null;
                            endpoint: {
                                id: string;
                                name: string;
                                context_length: number;
                                model: {
                                    slug: string;
                                    hf_slug: string | null;
                                    updated_at: string;
                                    created_at: string;
                                    hf_updated_at: string | null;
                                    name: string;
                                    short_name: string;
                                    author: string;
                                    description: string;
                                    model_version_group_id: string | null;
                                    context_length: number;
                                    input_modalities: string[];
                                    output_modalities: string[];
                                    has_text_output: boolean;
                                    group: string;
                                    instruct_type: string | null;
                                    default_system: string | null;
                                    default_stops: string[];
                                    hidden: boolean;
                                    router: string | null;
                                    warning_message: string | null;
                                    permaslug: string;
                                    reasoning_config: {
                                        start_token?: string | null | undefined;
                                        end_token?: string | null | undefined;
                                        system_prompt?: string | null | undefined;
                                    } | null;
                                    features: {
                                        [x: string]: unknown;
                                        reasoning_config?: {
                                            start_token?: string | null | undefined;
                                            end_token?: string | null | undefined;
                                            system_prompt?: string | null | undefined;
                                        } | undefined;
                                        supports_implicit_caching?: boolean | undefined;
                                        supports_file_urls?: boolean | undefined;
                                        supports_input_audio?: boolean | undefined;
                                        supports_tool_choice?: {
                                            literal_none: boolean;
                                            literal_auto: boolean;
                                            literal_required: boolean;
                                            type_function: boolean;
                                        } | undefined;
                                        supported_parameters?: {
                                            [x: string]: unknown;
                                            response_format?: boolean | undefined;
                                            structured_outputs?: boolean | undefined;
                                        } | undefined;
                                    } | null;
                                    default_parameters: Record<string, unknown> | null;
                                };
                                model_variant_slug: string;
                                model_variant_permaslug: string;
                                adapter_name: string;
                                provider_name: string;
                                provider_info: {
                                    name: string;
                                    displayName: string;
                                    slug: string;
                                    baseUrl: string;
                                    dataPolicy: {
                                        training: boolean;
                                        retainsPrompts: boolean;
                                        canPublish: boolean;
                                        termsOfServiceURL?: string | undefined;
                                        privacyPolicyURL?: string | undefined;
                                        requiresUserIDs?: boolean | undefined;
                                    };
                                    hasChatCompletions: boolean;
                                    hasCompletions: boolean;
                                    isAbortable: boolean;
                                    moderationRequired: boolean;
                                    editors: string[];
                                    owners: string[];
                                    adapterName: string;
                                    statusPageUrl: string | null;
                                    byokEnabled: boolean;
                                    ignoredProviderModels: string[];
                                    headquarters?: string | undefined;
                                    isMultipartSupported?: boolean | undefined;
                                    icon?: {
                                        url: string;
                                        className?: string | undefined;
                                    } | undefined;
                                };
                                provider_display_name: string;
                                provider_slug: string;
                                provider_model_id: string;
                                quantization: string | null;
                                variant: string;
                                is_free: boolean;
                                can_abort: boolean;
                                max_prompt_tokens: number | null;
                                max_completion_tokens: number | null;
                                max_tokens_per_image: number | null;
                                supported_parameters: string[];
                                is_byok: boolean;
                                moderation_required: boolean;
                                data_policy: {
                                    training: boolean;
                                    retainsPrompts: boolean;
                                    canPublish: boolean;
                                    termsOfServiceURL?: string | undefined;
                                    privacyPolicyURL?: string | undefined;
                                    requiresUserIDs?: boolean | undefined;
                                };
                                pricing: {
                                    prompt: string;
                                    completion: string;
                                    discount: number;
                                    image?: string | undefined;
                                    request?: string | undefined;
                                    web_search?: string | undefined;
                                    internal_reasoning?: string | undefined;
                                    image_output?: string | undefined;
                                    input_cache_read?: string | undefined;
                                };
                                variable_pricings: unknown[];
                                is_hidden: boolean;
                                is_deranked: boolean;
                                is_disabled: boolean;
                                supports_tool_parameters: boolean;
                                supports_reasoning: boolean;
                                supports_multipart: boolean;
                                limit_rpm: number | null;
                                limit_rpd: number | null;
                                limit_rpm_cf: number | null;
                                has_completions: boolean;
                                has_chat_completions: boolean;
                                features: {
                                    [x: string]: unknown;
                                    reasoning_config?: {
                                        start_token?: string | null | undefined;
                                        end_token?: string | null | undefined;
                                        system_prompt?: string | null | undefined;
                                    } | undefined;
                                    supports_implicit_caching?: boolean | undefined;
                                    supports_file_urls?: boolean | undefined;
                                    supports_input_audio?: boolean | undefined;
                                    supports_tool_choice?: {
                                        literal_none: boolean;
                                        literal_auto: boolean;
                                        literal_required: boolean;
                                        type_function: boolean;
                                    } | undefined;
                                    supported_parameters?: {
                                        [x: string]: unknown;
                                        response_format?: boolean | undefined;
                                        structured_outputs?: boolean | undefined;
                                    } | undefined;
                                } | null;
                                provider_region: string | null;
                            } | null;
                        };
                        benchmarks: {
                            artificialAnalysis?: {
                                codingIndex?: number | undefined;
                                liveCodeBench?: number | undefined;
                                sciCode?: number | undefined;
                                terminalBenchHard?: number | undefined;
                                lcr?: number | undefined;
                                ifBench?: number | undefined;
                                lastUpdated?: string | undefined;
                            } | undefined;
                        } | null | undefined;
                        chartData: {
                            weeklyTokenUsage?: {
                                dataPoints: {
                                    date: string;
                                    tokens: number;
                                }[];
                                lastUpdated: string;
                            } | undefined;
                            modeRankings?: {
                                lastUpdated: string;
                                architect?: number | undefined;
                                code?: number | undefined;
                                ask?: number | undefined;
                                debug?: number | undefined;
                                orchestrator?: number | undefined;
                            } | undefined;
                        } | null | undefined;
                        createdAt: string;
                        updatedAt: string;
                    }[];
                    pagination: {
                        page: number;
                        limit: number;
                        total: number;
                        totalPages: number;
                    };
                    lastUpdated: string | null;
                };
                meta: object;
            }>;
            create: _trpc_server.TRPCMutationProcedure<{
                input: {
                    openrouterId: string;
                    name: string;
                    slug?: string | undefined;
                    aaSlug?: string | undefined;
                    isActive?: boolean | undefined;
                };
                output: {
                    description: string | null;
                    id: string;
                    name: string;
                    slug: string | null;
                    codingIndex: string | null;
                    isActive: boolean | null;
                    isFeatured: boolean;
                    isStealth: boolean;
                    isRecommended: boolean;
                    openrouterId: string;
                    aaSlug: string | null;
                    modelCreator: string | null;
                    creatorSlug: string | null;
                    releaseDate: string | null;
                    priceInput: string | null;
                    priceOutput: string | null;
                    speedTokensPerSec: string | null;
                    contextLength: number | null;
                    maxOutputTokens: number | null;
                    inputModalities: string[] | null;
                    openrouterData: {
                        slug: string;
                        hf_slug: string | null;
                        updated_at: string;
                        created_at: string;
                        hf_updated_at: string | null;
                        name: string;
                        short_name: string;
                        author: string;
                        description: string;
                        model_version_group_id: string | null;
                        context_length: number;
                        input_modalities: string[];
                        output_modalities: string[];
                        has_text_output: boolean;
                        group: string;
                        instruct_type: string | null;
                        default_system: string | null;
                        default_stops: string[];
                        hidden: boolean;
                        router: string | null;
                        warning_message: string | null;
                        permaslug: string;
                        reasoning_config: {
                            start_token?: string | null | undefined;
                            end_token?: string | null | undefined;
                            system_prompt?: string | null | undefined;
                        } | null;
                        features: {
                            [x: string]: unknown;
                            reasoning_config?: {
                                start_token?: string | null | undefined;
                                end_token?: string | null | undefined;
                                system_prompt?: string | null | undefined;
                            } | undefined;
                            supports_implicit_caching?: boolean | undefined;
                            supports_file_urls?: boolean | undefined;
                            supports_input_audio?: boolean | undefined;
                            supports_tool_choice?: {
                                literal_none: boolean;
                                literal_auto: boolean;
                                literal_required: boolean;
                                type_function: boolean;
                            } | undefined;
                            supported_parameters?: {
                                [x: string]: unknown;
                                response_format?: boolean | undefined;
                                structured_outputs?: boolean | undefined;
                            } | undefined;
                        } | null;
                        default_parameters: Record<string, unknown> | null;
                        endpoint: {
                            id: string;
                            name: string;
                            context_length: number;
                            model: {
                                slug: string;
                                hf_slug: string | null;
                                updated_at: string;
                                created_at: string;
                                hf_updated_at: string | null;
                                name: string;
                                short_name: string;
                                author: string;
                                description: string;
                                model_version_group_id: string | null;
                                context_length: number;
                                input_modalities: string[];
                                output_modalities: string[];
                                has_text_output: boolean;
                                group: string;
                                instruct_type: string | null;
                                default_system: string | null;
                                default_stops: string[];
                                hidden: boolean;
                                router: string | null;
                                warning_message: string | null;
                                permaslug: string;
                                reasoning_config: {
                                    start_token?: string | null | undefined;
                                    end_token?: string | null | undefined;
                                    system_prompt?: string | null | undefined;
                                } | null;
                                features: {
                                    [x: string]: unknown;
                                    reasoning_config?: {
                                        start_token?: string | null | undefined;
                                        end_token?: string | null | undefined;
                                        system_prompt?: string | null | undefined;
                                    } | undefined;
                                    supports_implicit_caching?: boolean | undefined;
                                    supports_file_urls?: boolean | undefined;
                                    supports_input_audio?: boolean | undefined;
                                    supports_tool_choice?: {
                                        literal_none: boolean;
                                        literal_auto: boolean;
                                        literal_required: boolean;
                                        type_function: boolean;
                                    } | undefined;
                                    supported_parameters?: {
                                        [x: string]: unknown;
                                        response_format?: boolean | undefined;
                                        structured_outputs?: boolean | undefined;
                                    } | undefined;
                                } | null;
                                default_parameters: Record<string, unknown> | null;
                            };
                            model_variant_slug: string;
                            model_variant_permaslug: string;
                            adapter_name: string;
                            provider_name: string;
                            provider_info: {
                                name: string;
                                displayName: string;
                                slug: string;
                                baseUrl: string;
                                dataPolicy: {
                                    training: boolean;
                                    retainsPrompts: boolean;
                                    canPublish: boolean;
                                    termsOfServiceURL?: string | undefined;
                                    privacyPolicyURL?: string | undefined;
                                    requiresUserIDs?: boolean | undefined;
                                };
                                hasChatCompletions: boolean;
                                hasCompletions: boolean;
                                isAbortable: boolean;
                                moderationRequired: boolean;
                                editors: string[];
                                owners: string[];
                                adapterName: string;
                                statusPageUrl: string | null;
                                byokEnabled: boolean;
                                ignoredProviderModels: string[];
                                headquarters?: string | undefined;
                                isMultipartSupported?: boolean | undefined;
                                icon?: {
                                    url: string;
                                    className?: string | undefined;
                                } | undefined;
                            };
                            provider_display_name: string;
                            provider_slug: string;
                            provider_model_id: string;
                            quantization: string | null;
                            variant: string;
                            is_free: boolean;
                            can_abort: boolean;
                            max_prompt_tokens: number | null;
                            max_completion_tokens: number | null;
                            max_tokens_per_image: number | null;
                            supported_parameters: string[];
                            is_byok: boolean;
                            moderation_required: boolean;
                            data_policy: {
                                training: boolean;
                                retainsPrompts: boolean;
                                canPublish: boolean;
                                termsOfServiceURL?: string | undefined;
                                privacyPolicyURL?: string | undefined;
                                requiresUserIDs?: boolean | undefined;
                            };
                            pricing: {
                                prompt: string;
                                completion: string;
                                discount: number;
                                image?: string | undefined;
                                request?: string | undefined;
                                web_search?: string | undefined;
                                internal_reasoning?: string | undefined;
                                image_output?: string | undefined;
                                input_cache_read?: string | undefined;
                            };
                            variable_pricings: unknown[];
                            is_hidden: boolean;
                            is_deranked: boolean;
                            is_disabled: boolean;
                            supports_tool_parameters: boolean;
                            supports_reasoning: boolean;
                            supports_multipart: boolean;
                            limit_rpm: number | null;
                            limit_rpd: number | null;
                            limit_rpm_cf: number | null;
                            has_completions: boolean;
                            has_chat_completions: boolean;
                            features: {
                                [x: string]: unknown;
                                reasoning_config?: {
                                    start_token?: string | null | undefined;
                                    end_token?: string | null | undefined;
                                    system_prompt?: string | null | undefined;
                                } | undefined;
                                supports_implicit_caching?: boolean | undefined;
                                supports_file_urls?: boolean | undefined;
                                supports_input_audio?: boolean | undefined;
                                supports_tool_choice?: {
                                    literal_none: boolean;
                                    literal_auto: boolean;
                                    literal_required: boolean;
                                    type_function: boolean;
                                } | undefined;
                                supported_parameters?: {
                                    [x: string]: unknown;
                                    response_format?: boolean | undefined;
                                    structured_outputs?: boolean | undefined;
                                } | undefined;
                            } | null;
                            provider_region: string | null;
                        } | null;
                    };
                    benchmarks: {
                        artificialAnalysis?: {
                            codingIndex?: number | undefined;
                            liveCodeBench?: number | undefined;
                            sciCode?: number | undefined;
                            terminalBenchHard?: number | undefined;
                            lcr?: number | undefined;
                            ifBench?: number | undefined;
                            lastUpdated?: string | undefined;
                        } | undefined;
                    } | null | undefined;
                    chartData: {
                        weeklyTokenUsage?: {
                            dataPoints: {
                                date: string;
                                tokens: number;
                            }[];
                            lastUpdated: string;
                        } | undefined;
                        modeRankings?: {
                            lastUpdated: string;
                            architect?: number | undefined;
                            code?: number | undefined;
                            ask?: number | undefined;
                            debug?: number | undefined;
                            orchestrator?: number | undefined;
                        } | undefined;
                    } | null | undefined;
                    createdAt: string;
                    updatedAt: string;
                };
                meta: object;
            }>;
            update: _trpc_server.TRPCMutationProcedure<{
                input: {
                    id: string;
                    aaSlug?: string | null | undefined;
                    isActive?: boolean | undefined;
                    isFeatured?: boolean | undefined;
                    isStealth?: boolean | undefined;
                };
                output: {
                    id: string;
                    isActive: boolean | null;
                    isFeatured: boolean;
                    isStealth: boolean;
                    isRecommended: boolean;
                    openrouterId: string;
                    slug: string | null;
                    aaSlug: string | null;
                    name: string;
                    description: string | null;
                    modelCreator: string | null;
                    creatorSlug: string | null;
                    releaseDate: string | null;
                    priceInput: string | null;
                    priceOutput: string | null;
                    codingIndex: string | null;
                    speedTokensPerSec: string | null;
                    contextLength: number | null;
                    maxOutputTokens: number | null;
                    inputModalities: string[] | null;
                    openrouterData: {
                        slug: string;
                        hf_slug: string | null;
                        updated_at: string;
                        created_at: string;
                        hf_updated_at: string | null;
                        name: string;
                        short_name: string;
                        author: string;
                        description: string;
                        model_version_group_id: string | null;
                        context_length: number;
                        input_modalities: string[];
                        output_modalities: string[];
                        has_text_output: boolean;
                        group: string;
                        instruct_type: string | null;
                        default_system: string | null;
                        default_stops: string[];
                        hidden: boolean;
                        router: string | null;
                        warning_message: string | null;
                        permaslug: string;
                        reasoning_config: {
                            start_token?: string | null | undefined;
                            end_token?: string | null | undefined;
                            system_prompt?: string | null | undefined;
                        } | null;
                        features: {
                            [x: string]: unknown;
                            reasoning_config?: {
                                start_token?: string | null | undefined;
                                end_token?: string | null | undefined;
                                system_prompt?: string | null | undefined;
                            } | undefined;
                            supports_implicit_caching?: boolean | undefined;
                            supports_file_urls?: boolean | undefined;
                            supports_input_audio?: boolean | undefined;
                            supports_tool_choice?: {
                                literal_none: boolean;
                                literal_auto: boolean;
                                literal_required: boolean;
                                type_function: boolean;
                            } | undefined;
                            supported_parameters?: {
                                [x: string]: unknown;
                                response_format?: boolean | undefined;
                                structured_outputs?: boolean | undefined;
                            } | undefined;
                        } | null;
                        default_parameters: Record<string, unknown> | null;
                        endpoint: {
                            id: string;
                            name: string;
                            context_length: number;
                            model: {
                                slug: string;
                                hf_slug: string | null;
                                updated_at: string;
                                created_at: string;
                                hf_updated_at: string | null;
                                name: string;
                                short_name: string;
                                author: string;
                                description: string;
                                model_version_group_id: string | null;
                                context_length: number;
                                input_modalities: string[];
                                output_modalities: string[];
                                has_text_output: boolean;
                                group: string;
                                instruct_type: string | null;
                                default_system: string | null;
                                default_stops: string[];
                                hidden: boolean;
                                router: string | null;
                                warning_message: string | null;
                                permaslug: string;
                                reasoning_config: {
                                    start_token?: string | null | undefined;
                                    end_token?: string | null | undefined;
                                    system_prompt?: string | null | undefined;
                                } | null;
                                features: {
                                    [x: string]: unknown;
                                    reasoning_config?: {
                                        start_token?: string | null | undefined;
                                        end_token?: string | null | undefined;
                                        system_prompt?: string | null | undefined;
                                    } | undefined;
                                    supports_implicit_caching?: boolean | undefined;
                                    supports_file_urls?: boolean | undefined;
                                    supports_input_audio?: boolean | undefined;
                                    supports_tool_choice?: {
                                        literal_none: boolean;
                                        literal_auto: boolean;
                                        literal_required: boolean;
                                        type_function: boolean;
                                    } | undefined;
                                    supported_parameters?: {
                                        [x: string]: unknown;
                                        response_format?: boolean | undefined;
                                        structured_outputs?: boolean | undefined;
                                    } | undefined;
                                } | null;
                                default_parameters: Record<string, unknown> | null;
                            };
                            model_variant_slug: string;
                            model_variant_permaslug: string;
                            adapter_name: string;
                            provider_name: string;
                            provider_info: {
                                name: string;
                                displayName: string;
                                slug: string;
                                baseUrl: string;
                                dataPolicy: {
                                    training: boolean;
                                    retainsPrompts: boolean;
                                    canPublish: boolean;
                                    termsOfServiceURL?: string | undefined;
                                    privacyPolicyURL?: string | undefined;
                                    requiresUserIDs?: boolean | undefined;
                                };
                                hasChatCompletions: boolean;
                                hasCompletions: boolean;
                                isAbortable: boolean;
                                moderationRequired: boolean;
                                editors: string[];
                                owners: string[];
                                adapterName: string;
                                statusPageUrl: string | null;
                                byokEnabled: boolean;
                                ignoredProviderModels: string[];
                                headquarters?: string | undefined;
                                isMultipartSupported?: boolean | undefined;
                                icon?: {
                                    url: string;
                                    className?: string | undefined;
                                } | undefined;
                            };
                            provider_display_name: string;
                            provider_slug: string;
                            provider_model_id: string;
                            quantization: string | null;
                            variant: string;
                            is_free: boolean;
                            can_abort: boolean;
                            max_prompt_tokens: number | null;
                            max_completion_tokens: number | null;
                            max_tokens_per_image: number | null;
                            supported_parameters: string[];
                            is_byok: boolean;
                            moderation_required: boolean;
                            data_policy: {
                                training: boolean;
                                retainsPrompts: boolean;
                                canPublish: boolean;
                                termsOfServiceURL?: string | undefined;
                                privacyPolicyURL?: string | undefined;
                                requiresUserIDs?: boolean | undefined;
                            };
                            pricing: {
                                prompt: string;
                                completion: string;
                                discount: number;
                                image?: string | undefined;
                                request?: string | undefined;
                                web_search?: string | undefined;
                                internal_reasoning?: string | undefined;
                                image_output?: string | undefined;
                                input_cache_read?: string | undefined;
                            };
                            variable_pricings: unknown[];
                            is_hidden: boolean;
                            is_deranked: boolean;
                            is_disabled: boolean;
                            supports_tool_parameters: boolean;
                            supports_reasoning: boolean;
                            supports_multipart: boolean;
                            limit_rpm: number | null;
                            limit_rpd: number | null;
                            limit_rpm_cf: number | null;
                            has_completions: boolean;
                            has_chat_completions: boolean;
                            features: {
                                [x: string]: unknown;
                                reasoning_config?: {
                                    start_token?: string | null | undefined;
                                    end_token?: string | null | undefined;
                                    system_prompt?: string | null | undefined;
                                } | undefined;
                                supports_implicit_caching?: boolean | undefined;
                                supports_file_urls?: boolean | undefined;
                                supports_input_audio?: boolean | undefined;
                                supports_tool_choice?: {
                                    literal_none: boolean;
                                    literal_auto: boolean;
                                    literal_required: boolean;
                                    type_function: boolean;
                                } | undefined;
                                supported_parameters?: {
                                    [x: string]: unknown;
                                    response_format?: boolean | undefined;
                                    structured_outputs?: boolean | undefined;
                                } | undefined;
                            } | null;
                            provider_region: string | null;
                        } | null;
                    };
                    benchmarks: {
                        artificialAnalysis?: {
                            codingIndex?: number | undefined;
                            liveCodeBench?: number | undefined;
                            sciCode?: number | undefined;
                            terminalBenchHard?: number | undefined;
                            lcr?: number | undefined;
                            ifBench?: number | undefined;
                            lastUpdated?: string | undefined;
                        } | undefined;
                    } | null | undefined;
                    chartData: {
                        weeklyTokenUsage?: {
                            dataPoints: {
                                date: string;
                                tokens: number;
                            }[];
                            lastUpdated: string;
                        } | undefined;
                        modeRankings?: {
                            lastUpdated: string;
                            architect?: number | undefined;
                            code?: number | undefined;
                            ask?: number | undefined;
                            debug?: number | undefined;
                            orchestrator?: number | undefined;
                        } | undefined;
                    } | null | undefined;
                    createdAt: string;
                    updatedAt: string;
                };
                meta: object;
            }>;
            triggerSync: _trpc_server.TRPCMutationProcedure<{
                input: void;
                output: {
                    success: boolean;
                    message?: string | undefined;
                };
                meta: object;
            }>;
            bustCache: _trpc_server.TRPCMutationProcedure<{
                input: void;
                output: {
                    success: boolean;
                    message: string;
                };
                meta: object;
            }>;
        }>>;
        deployments: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    page?: number | undefined;
                    limit?: number | undefined;
                    sortBy?: "created_at" | "deployment_slug" | "repository_source" | undefined;
                    sortOrder?: "asc" | "desc" | undefined;
                    search?: string | undefined;
                    ownerType?: "user" | "all" | "org" | undefined;
                };
                output: {
                    deployments: AdminDeploymentTableProps[];
                    pagination: {
                        page: number;
                        limit: number;
                        total: number;
                        totalPages: number;
                    };
                };
                meta: object;
            }>;
            getBuilds: _trpc_server.TRPCQueryProcedure<{
                input: {
                    deploymentId: string;
                };
                output: {
                    builds: AdminDeploymentBuild[];
                };
                meta: object;
            }>;
            getBuildEvents: _trpc_server.TRPCQueryProcedure<{
                input: {
                    buildId: string;
                    limit?: number | undefined;
                    afterEventId?: number | undefined;
                };
                output: {
                    events: {
                        id: number;
                        ts: string;
                        type: "log" | "status_change";
                        payload: unknown;
                    }[];
                };
                meta: object;
            }>;
            delete: _trpc_server.TRPCMutationProcedure<{
                input: {
                    id: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
        }>>;
        alerting: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            listConfigs: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: {
                    success: boolean;
                    configs: {
                        model: string;
                        enabled: boolean;
                        errorRateSlo: number;
                        minRequestsPerWindow: number;
                    }[];
                };
                meta: object;
            }>;
            updateConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    model: string;
                    enabled: boolean;
                    errorRateSlo: number;
                    minRequestsPerWindow: number;
                };
                output: {
                    success: boolean;
                    config: {
                        model: string;
                        enabled: boolean;
                        errorRateSlo: number;
                        minRequestsPerWindow: number;
                        updatedAt: string;
                    };
                };
                meta: object;
            }>;
            deleteConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    model: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            getBaseline: _trpc_server.TRPCMutationProcedure<{
                input: {
                    model: string;
                };
                output: {
                    success: boolean;
                    baseline: {
                        model: string;
                        errorRate1d: number;
                        errorRate3d: number;
                        errorRate7d: number;
                        requests1d: number;
                        requests3d: number;
                        requests7d: number;
                    } | null;
                };
                meta: object;
            }>;
            listTtfbConfigs: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: {
                    success: boolean;
                    configs: {
                        model: string;
                        enabled: boolean;
                        ttfbThresholdMs: number;
                        ttfbSlo: number;
                        minRequestsPerWindow: number;
                    }[];
                };
                meta: object;
            }>;
            updateTtfbConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    model: string;
                    enabled: boolean;
                    ttfbThresholdMs: number;
                    ttfbSlo: number;
                    minRequestsPerWindow: number;
                };
                output: {
                    success: boolean;
                    config: {
                        model: string;
                        enabled: boolean;
                        ttfbThresholdMs: number;
                        ttfbSlo: number;
                        minRequestsPerWindow: number;
                        updatedAt: string;
                    };
                };
                meta: object;
            }>;
            deleteTtfbConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    model: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            getTtfbBaseline: _trpc_server.TRPCMutationProcedure<{
                input: {
                    model: string;
                };
                output: {
                    success: boolean;
                    baseline: {
                        model: string;
                        p50Ttfb3d: number;
                        p95Ttfb3d: number;
                        p99Ttfb3d: number;
                        requests3d: number;
                    } | null;
                };
                meta: object;
            }>;
        }>>;
        featureInterest: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            list: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: {
                    leaderboard: FeatureInterestLeaderboard[];
                    bySlug: FeatureSlugLeaderboard[];
                    leaderboardQuery: string;
                    bySlugQuery: string;
                };
                meta: object;
            }>;
            timeline: _trpc_server.TRPCQueryProcedure<{
                input: {
                    weeks?: number | undefined;
                };
                output: {
                    timeline: FeatureInterestTimelineEntry[];
                    query: string;
                };
                meta: object;
            }>;
            detail: _trpc_server.TRPCQueryProcedure<{
                input: {
                    slug: string;
                    name?: string | null | undefined;
                    limit?: number | undefined;
                    offset?: number | undefined;
                };
                output: {
                    feature: string;
                    users: FeatureSignupUser[];
                    total_count: number;
                    usersQuery: string;
                    countQuery: string;
                };
                meta: object;
            }>;
        }>>;
        codeReviews: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getOverviewStats: _trpc_server.TRPCQueryProcedure<{
                input: {
                    startDate: string;
                    endDate: string;
                    userId?: string | undefined;
                    organizationId?: string | undefined;
                    ownershipType?: "organization" | "all" | "personal" | undefined;
                    agentVersion?: "all" | "v1" | "v2" | undefined;
                };
                output: {
                    totalReviews: number;
                    completedCount: number;
                    failedCount: number;
                    cancelledCount: number;
                    interruptedCount: number;
                    inProgressCount: number;
                    billingErrorCount: number;
                    billingRate: number;
                    successRate: number;
                    failureRate: number;
                    cancelledRate: number;
                    avgDurationSeconds: number;
                    versionBreakdown: {
                        agentVersion: string;
                        total: number;
                        completed: number;
                        failed: number;
                        avgDurationSeconds: number;
                    }[] | undefined;
                };
                meta: object;
            }>;
            getDailyStats: _trpc_server.TRPCQueryProcedure<{
                input: {
                    startDate: string;
                    endDate: string;
                    userId?: string | undefined;
                    organizationId?: string | undefined;
                    ownershipType?: "organization" | "all" | "personal" | undefined;
                    agentVersion?: "all" | "v1" | "v2" | undefined;
                };
                output: {
                    day: string;
                    total: number;
                    completed: number;
                    failed: number;
                    cancelled: number;
                    interrupted: number;
                    inProgress: number;
                    billingErrors: number;
                }[];
                meta: object;
            }>;
            getCancellationAnalysis: _trpc_server.TRPCQueryProcedure<{
                input: {
                    startDate: string;
                    endDate: string;
                    userId?: string | undefined;
                    organizationId?: string | undefined;
                    ownershipType?: "organization" | "all" | "personal" | undefined;
                    agentVersion?: "all" | "v1" | "v2" | undefined;
                };
                output: {
                    reason: string;
                    count: number;
                    firstOccurrence: string;
                    lastOccurrence: string;
                }[];
                meta: object;
            }>;
            getErrorAnalysis: _trpc_server.TRPCQueryProcedure<{
                input: {
                    startDate: string;
                    endDate: string;
                    userId?: string | undefined;
                    organizationId?: string | undefined;
                    ownershipType?: "organization" | "all" | "personal" | undefined;
                    agentVersion?: "all" | "v1" | "v2" | undefined;
                };
                output: {
                    categories: {
                        category: string;
                        count: number;
                        firstOccurrence: string;
                        lastOccurrence: string;
                    }[];
                    details: {
                        errorType: string;
                        category: string;
                        count: number;
                        firstOccurrence: string;
                        lastOccurrence: string;
                    }[];
                };
                meta: object;
            }>;
            getErrorSessions: _trpc_server.TRPCQueryProcedure<{
                input: {
                    startDate: string;
                    endDate: string;
                    errorMessage: string;
                    userId?: string | undefined;
                    organizationId?: string | undefined;
                    ownershipType?: "organization" | "all" | "personal" | undefined;
                    agentVersion?: "all" | "v1" | "v2" | undefined;
                };
                output: {
                    sessionId: string | null;
                    cliSessionId: string | null;
                    userId: string | null;
                    orgId: string | null;
                    errorMessage: string | null;
                    createdAt: string;
                    repoFullName: string;
                    prNumber: number;
                    agentVersion: string | null;
                }[];
                meta: object;
            }>;
            getUserSegmentation: _trpc_server.TRPCQueryProcedure<{
                input: {
                    startDate: string;
                    endDate: string;
                    userId?: string | undefined;
                    organizationId?: string | undefined;
                    ownershipType?: "organization" | "all" | "personal" | undefined;
                    agentVersion?: "all" | "v1" | "v2" | undefined;
                };
                output: {
                    ownershipBreakdown: {
                        type: string;
                        count: number;
                        completed: number;
                        failed: number;
                    }[];
                    topUsers: {
                        userId: string | null;
                        email: string | null;
                        name: string | null;
                        reviewCount: number;
                        completedCount: number;
                    }[];
                    topOrgs: {
                        orgId: string | null;
                        name: string | null;
                        plan: "teams" | "enterprise" | null;
                        reviewCount: number;
                        completedCount: number;
                    }[];
                };
                meta: object;
            }>;
            getPerformanceStats: _trpc_server.TRPCQueryProcedure<{
                input: {
                    startDate: string;
                    endDate: string;
                    userId?: string | undefined;
                    organizationId?: string | undefined;
                    ownershipType?: "organization" | "all" | "personal" | undefined;
                    agentVersion?: "all" | "v1" | "v2" | undefined;
                };
                output: {
                    day: string;
                    agentVersion: string;
                    avgSeconds: number;
                    p50Seconds: number;
                    p90Seconds: number;
                    count: number;
                }[];
                meta: object;
            }>;
            getExportData: _trpc_server.TRPCQueryProcedure<{
                input: {
                    startDate: string;
                    endDate: string;
                    userId?: string | undefined;
                    organizationId?: string | undefined;
                    ownershipType?: "organization" | "all" | "personal" | undefined;
                    agentVersion?: "all" | "v1" | "v2" | undefined;
                };
                output: {
                    id: string;
                    owned_by_organization_id: string | null;
                    owned_by_user_id: string | null;
                    repo_full_name: string;
                    pr_number: number;
                    pr_title: string;
                    pr_author: string;
                    status: string;
                    error_message: string | null;
                    terminal_reason: string | null;
                    started_at: string | null;
                    completed_at: string | null;
                    created_at: string;
                    session_id: string | null;
                }[];
                meta: object;
            }>;
            searchUsers: _trpc_server.TRPCQueryProcedure<{
                input: {
                    query: string;
                };
                output: {
                    id: string;
                    email: string;
                    name: string;
                }[];
                meta: object;
            }>;
            searchOrganizations: _trpc_server.TRPCQueryProcedure<{
                input: {
                    query: string;
                };
                output: {
                    id: string;
                    name: string;
                    plan: "teams" | "enterprise";
                }[];
                meta: object;
            }>;
            getReviewPromotionStats: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: {
                    promoActive: boolean;
                    promoStart: string;
                    promoEnd: string;
                    totalRequests: number;
                    uniqueUsers: number;
                    uniqueOrgs: number;
                    daily: {
                        day: string;
                        total: number;
                        uniqueUsers: number;
                    }[];
                };
                meta: object;
            }>;
        }>>;
        sessionTraces: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            resolveCloudAgentSession: _trpc_server.TRPCQueryProcedure<{
                input: {
                    cloud_agent_session_id: string;
                };
                output: {
                    session_id: string;
                };
                meta: object;
            }>;
            get: _trpc_server.TRPCQueryProcedure<{
                input: {
                    session_id: string;
                };
                output: {
                    last_mode: null;
                    last_model: null;
                    user: {
                        id: string;
                        email: string;
                        name: string;
                        image: string;
                    } | null;
                    session_id: string;
                    kilo_user_id: string;
                    version: number;
                    title: string | null;
                    public_id: string | null;
                    parent_session_id: string | null;
                    organization_id: string | null;
                    cloud_agent_session_id: string | null;
                    created_on_platform: string;
                    git_url: string | null;
                    git_branch: string | null;
                    created_at: string;
                    updated_at: string;
                } | {
                    git_branch: null;
                    user: {
                        id: string;
                        email: string;
                        name: string;
                        image: string;
                    } | null;
                    session_id: string;
                    kilo_user_id: string;
                    title: string;
                    created_on_platform: string;
                    api_conversation_history_blob_url: string | null;
                    task_metadata_blob_url: string | null;
                    ui_messages_blob_url: string | null;
                    git_state_blob_url: string | null;
                    git_url: string | null;
                    forked_from: string | null;
                    parent_session_id: string | null;
                    cloud_agent_session_id: string | null;
                    organization_id: string | null;
                    last_mode: string | null;
                    last_model: string | null;
                    version: number;
                    created_at: string;
                    updated_at: string;
                };
                meta: object;
            }>;
            getMessages: _trpc_server.TRPCQueryProcedure<{
                input: {
                    session_id: string;
                };
                output: {
                    messages: {
                        [x: string]: unknown;
                        info: {
                            [x: string]: unknown;
                            id: string;
                        };
                        parts: {
                            [x: string]: unknown;
                            id: string;
                        }[];
                    }[];
                    format: "v2";
                } | {
                    messages: unknown[];
                    format: "v1";
                };
                meta: object;
            }>;
            getApiConversationHistory: _trpc_server.TRPCQueryProcedure<{
                input: {
                    session_id: string;
                };
                output: {
                    history: {} | null;
                };
                meta: object;
            }>;
        }>>;
        appBuilder: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            get: _trpc_server.TRPCQueryProcedure<{
                input: {
                    id: string;
                };
                output: AdminAppBuilderProjectDetail;
                meta: object;
            }>;
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    offset?: number | undefined;
                    limit?: number | undefined;
                    sortBy?: "created_at" | "title" | "last_message_at" | undefined;
                    sortOrder?: "asc" | "desc" | undefined;
                    search?: string | undefined;
                    ownerType?: "user" | "all" | "org" | undefined;
                };
                output: {
                    projects: AdminAppBuilderProject[];
                    pagination: {
                        offset: number;
                        limit: number;
                        total: number;
                        totalPages: number;
                    };
                };
                meta: object;
            }>;
            delete: _trpc_server.TRPCMutationProcedure<{
                input: {
                    id: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
        }>>;
        kiloclawInstances: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            get: _trpc_server.TRPCQueryProcedure<{
                input: {
                    id: string;
                };
                output: {
                    derived_fly_app_name: string;
                    workerStatus: PlatformDebugStatusResponse | null;
                    workerStatusError: string | null;
                    id: string;
                    user_id: string;
                    sandbox_id: string;
                    created_at: string;
                    destroyed_at: string | null;
                    suspended_at: string | null;
                    user_email: string | null;
                };
                meta: object;
            }>;
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    offset?: number | undefined;
                    limit?: number | undefined;
                    sortBy?: "created_at" | "destroyed_at" | undefined;
                    sortOrder?: "asc" | "desc" | undefined;
                    search?: string | undefined;
                    status?: "active" | "all" | "suspended" | "destroyed" | undefined;
                };
                output: {
                    instances: AdminKiloclawInstance[];
                    pagination: {
                        offset: number;
                        limit: number;
                        total: number;
                        totalPages: number;
                    };
                };
                meta: object;
            }>;
            stats: _trpc_server.TRPCQueryProcedure<{
                input: {
                    days?: number | undefined;
                };
                output: {
                    overview: {
                        totalInstances: number;
                        activeInstances: number;
                        suspendedInstances: number;
                        destroyedInstances: number;
                        uniqueUsers: number;
                        last24hCreated: number;
                        last7dCreated: number;
                        activeUsers7d: number;
                        avgLifespanMinutes: number | null;
                    };
                    dailyChart: {
                        date: string;
                        created: number;
                        destroyed: number;
                    }[];
                };
                meta: object;
            }>;
            volumeSnapshots: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    snapshots: VolumeSnapshot[];
                };
                meta: object;
            }>;
            controllerVersion: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: ControllerVersionResponse;
                meta: object;
            }>;
            gatewayStatus: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: GatewayProcessStatusResponse;
                meta: object;
            }>;
            gatewayStart: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: GatewayProcessActionResponse;
                meta: object;
            }>;
            gatewayStop: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: GatewayProcessActionResponse;
                meta: object;
            }>;
            gatewayRestart: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: GatewayProcessActionResponse;
                meta: object;
            }>;
            runDoctor: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: DoctorResponse;
                meta: object;
            }>;
            restoreConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: ConfigRestoreResponse;
                meta: object;
            }>;
            fileTree: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: FileNode[];
                meta: object;
            }>;
            readFile: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                    path: string;
                };
                output: {
                    content: string;
                    etag: string;
                };
                meta: object;
            }>;
            writeFile: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                    path: string;
                    content: string;
                    etag?: string | undefined;
                };
                output: {
                    etag: string;
                };
                meta: object;
            }>;
            machineStart: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    ok: true;
                };
                meta: object;
            }>;
            forceRetryRecovery: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    ok: true;
                };
                meta: object;
            }>;
            machineStop: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    ok: true;
                };
                meta: object;
            }>;
            restartMachine: _trpc_server.TRPCMutationProcedure<{
                input: {
                    instanceId: string;
                    imageTag?: string | undefined;
                };
                output: RestartMachineResponse;
                meta: object;
            }>;
            destroy: _trpc_server.TRPCMutationProcedure<{
                input: {
                    id: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            adminAuditLogs: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                    action?: string | undefined;
                    limit?: number | undefined;
                };
                output: {
                    message: string;
                    id: string;
                    created_at: string;
                    action: "kiloclaw.volume.reassociate" | "kiloclaw.subscription.update_trial_end" | "kiloclaw.subscription.reset_trial" | "kiloclaw.machine.start" | "kiloclaw.machine.stop" | "kiloclaw.instance.destroy" | "kiloclaw.gateway.start" | "kiloclaw.gateway.stop" | "kiloclaw.gateway.restart" | "kiloclaw.config.restore" | "kiloclaw.doctor.run";
                    actor_id: string | null;
                    actor_email: string | null;
                    actor_name: string | null;
                    metadata: Record<string, unknown> | null;
                    target_user_id: string;
                }[];
                meta: object;
            }>;
            candidateVolumes: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: CandidateVolumesResponse;
                meta: object;
            }>;
            devNukeAll: _trpc_server.TRPCMutationProcedure<{
                input: void;
                output: {
                    total: number;
                    destroyed: number;
                    errors: {
                        userId: string;
                        error: string;
                    }[];
                };
                meta: object;
            }>;
            reassociateVolume: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                    newVolumeId: string;
                    reason: string;
                };
                output: ReassociateVolumeResponse;
                meta: object;
            }>;
        }>>;
        kiloclawVersions: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            listVersions: _trpc_server.TRPCQueryProcedure<{
                input: {
                    offset?: number | undefined;
                    limit?: number | undefined;
                    status?: "available" | "disabled" | undefined;
                };
                output: {
                    items: {
                        id: string;
                        openclaw_version: string;
                        variant: string;
                        image_tag: string;
                        image_digest: string | null;
                        status: "available" | "disabled";
                        description: string | null;
                        updated_by: string | null;
                        published_at: string;
                        synced_at: string;
                        created_at: string;
                        updated_at: string;
                    }[];
                    pagination: {
                        offset: number;
                        limit: number;
                        totalCount: number;
                        totalPages: number;
                    };
                };
                meta: object;
            }>;
            updateVersionStatus: _trpc_server.TRPCMutationProcedure<{
                input: {
                    imageTag: string;
                    status: "available" | "disabled";
                };
                output: {
                    id: string;
                    openclaw_version: string;
                    variant: string;
                    image_tag: string;
                    image_digest: string | null;
                    status: "available" | "disabled";
                    description: string | null;
                    updated_by: string | null;
                    published_at: string;
                    synced_at: string;
                    created_at: string;
                    updated_at: string;
                };
                meta: object;
            }>;
            listPins: _trpc_server.TRPCQueryProcedure<{
                input: {
                    offset?: number | undefined;
                    limit?: number | undefined;
                };
                output: {
                    items: {
                        user_email: string | null;
                        openclaw_version: string | null;
                        variant: string | null;
                        pinned_by_email: string | null;
                        id: string;
                        user_id: string;
                        image_tag: string;
                        pinned_by: string;
                        reason: string | null;
                        created_at: string;
                        updated_at: string;
                    }[];
                    pagination: {
                        offset: number;
                        limit: number;
                        totalCount: number;
                        totalPages: number;
                    };
                };
                meta: object;
            }>;
            getUserPin: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    openclaw_version: string | null;
                    variant: string | null;
                    pinned_by_email: string | null;
                    id: string;
                    user_id: string;
                    image_tag: string;
                    pinned_by: string;
                    reason: string | null;
                    created_at: string;
                    updated_at: string;
                } | null;
                meta: object;
            }>;
            setPin: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                    imageTag: string;
                    reason?: string | undefined;
                };
                output: {
                    id: string;
                    updated_at: string;
                    created_at: string;
                    user_id: string;
                    reason: string | null;
                    image_tag: string;
                    pinned_by: string;
                };
                meta: object;
            }>;
            removePin: _trpc_server.TRPCMutationProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    success: boolean;
                };
                meta: object;
            }>;
            getLatestTag: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: string | null;
                meta: object;
            }>;
            syncCatalog: _trpc_server.TRPCMutationProcedure<{
                input: void;
                output: {
                    synced: number;
                    alreadyExisted: number;
                    invalid: number;
                    total: number;
                };
                meta: object;
            }>;
            searchUsers: _trpc_server.TRPCQueryProcedure<{
                input: {
                    query: string;
                };
                output: {
                    id: string;
                    email: string;
                    name: string;
                }[];
                meta: object;
            }>;
        }>>;
        kiloclawRegions: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getRegions: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: RegionsResponse;
                meta: object;
            }>;
            updateRegions: _trpc_server.TRPCMutationProcedure<{
                input: {
                    regions: string[];
                };
                output: UpdateRegionsResponse;
                meta: object;
            }>;
        }>>;
        aiAttribution: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getDebugData: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organization_id: string;
                    project_id: string;
                    file_path: string;
                    branch?: string | undefined;
                };
                output: {
                    success: true;
                    data: {
                        doKey: string;
                        attributions: {
                            id: number;
                            user_id: string;
                            organization_id: string | null;
                            project_id: string;
                            branch: string;
                            file_path: string;
                            status: string;
                            task_id: string | null;
                            created_at: string;
                            lines_added: {
                                id: number;
                                attributions_metadata_id: number;
                                line_number: number;
                                line_hash: string;
                            }[];
                            lines_removed: {
                                id: number;
                                attributions_metadata_id: number;
                                line_number: number;
                                line_hash: string;
                            }[];
                        }[];
                        summary: {
                            total_attributions: number;
                            total_lines_added: number;
                            total_lines_removed: number;
                            by_status: Record<string, number>;
                            by_branch: Record<string, number>;
                        };
                    };
                } | {
                    success: false;
                    error: string;
                };
                meta: object;
            }>;
            searchProjects: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organization_id: string;
                    search?: string | undefined;
                    limit?: number | undefined;
                };
                output: string[];
                meta: object;
            }>;
            searchFilePaths: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organization_id: string;
                    project_id: string;
                    search?: string | undefined;
                    limit?: number | undefined;
                };
                output: string[];
                meta: object;
            }>;
            searchBranches: _trpc_server.TRPCQueryProcedure<{
                input: {
                    organization_id: string;
                    project_id: string;
                    search?: string | undefined;
                    limit?: number | undefined;
                };
                output: string[];
                meta: object;
            }>;
            deleteAttribution: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organization_id: string;
                    project_id: string;
                    file_path: string;
                    attribution_id: number;
                };
                output: {
                    success: true;
                    data: {
                        deleted: true;
                        attribution_id: number;
                    };
                } | {
                    success: false;
                    error: string;
                };
                meta: object;
            }>;
        }>>;
        ossSponsorship: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            processOssCsv: _trpc_server.TRPCMutationProcedure<{
                input: {
                    githubUrl: string;
                    email: string;
                    creditsDollars: number;
                    tier: 1 | 2 | 3;
                }[];
                output: {
                    email: string;
                    orgId: string | null;
                    success: boolean;
                    error?: string;
                }[];
                meta: object;
            }>;
            listOssSponsorships: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: {
                    email: string | null;
                    hasKiloAccount: boolean;
                    kiloUserId: string | null;
                    organizationId: string;
                    organizationName: string;
                    githubUrl: string | null;
                    tier: 1 | 2 | 3 | null;
                    monthlyCreditsUsd: number | null;
                    lastResetAt: string | null;
                    currentBalanceUsd: number;
                    createdAt: string;
                    hasGitHubIntegration: boolean;
                    hasCodeReviewsEnabled: boolean;
                    isOnboardingComplete: boolean;
                    hasCompletedCodeReview: boolean;
                    lastCodeReviewDate: string | null;
                }[];
                meta: object;
            }>;
            searchOrganizations: _trpc_server.TRPCQueryProcedure<{
                input: {
                    query: string;
                };
                output: {
                    id: string;
                    name: string;
                    plan: "teams" | "enterprise";
                    requireSeats: boolean;
                    suppressTrialMessaging: boolean;
                }[];
                meta: object;
            }>;
            addExistingOrgToOss: _trpc_server.TRPCMutationProcedure<{
                input: {
                    organizationId: string;
                    tier: 1 | 2 | 3;
                    monthlyTopUpDollars: number;
                    addInitialGrant: boolean;
                    sendEmail?: boolean | undefined;
                };
                output: {
                    success: boolean;
                    organizationId: string;
                    tier: 1 | 2 | 3;
                    monthlyTopUpDollars: number;
                    addInitialGrant: boolean;
                    sendEmail: boolean;
                };
                meta: object;
            }>;
        }>>;
        bulkUserCredits: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            matchUsers: _trpc_server.TRPCMutationProcedure<{
                input: {
                    emails: string[];
                };
                output: {
                    matched: {
                        email: string;
                        userId: string;
                        userName: string | null;
                    }[];
                    unmatched: {
                        email: string;
                    }[];
                };
                meta: object;
            }>;
            grantBulkCredits: _trpc_server.TRPCMutationProcedure<{
                input: {
                    emails: string[];
                    amountUsd: number;
                    expirationDate?: string | undefined;
                    description?: string | undefined;
                };
                output: {
                    email: string;
                    userId: string;
                    success: boolean;
                    error?: string;
                }[];
                meta: object;
            }>;
        }>>;
        emailTesting: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getTemplates: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: {
                    name: "orgSubscription" | "orgRenewed" | "orgCancelled" | "orgSSOUserJoined" | "orgInvitation" | "magicLink" | "balanceAlert" | "autoTopUpFailed" | "ossInviteNewUser" | "ossInviteExistingUser" | "ossExistingOrgProvisioned" | "deployFailed" | "clawTrialEndingSoon" | "clawTrialExpiresTomorrow" | "clawSuspendedTrial" | "clawSuspendedSubscription" | "clawSuspendedPayment" | "clawDestructionWarning" | "clawInstanceDestroyed" | "clawEarlybirdEndingSoon" | "clawEarlybirdExpiresTomorrow" | "clawInstanceReady";
                    subject: "Welcome to Kilo for Teams!" | "Kilo: Your Teams Subscription Renewal" | "Kilo: Your Teams Subscription is Cancelled" | "Kilo: New SSO User Joined Your Organization" | "Kilo: Teams Invitation" | "Sign in to Kilo Code" | "Kilo: Low Balance Alert" | "Kilo: Auto Top-Up Failed" | "Kilo: OSS Sponsorship Offer" | "Kilo: Your Deployment Failed" | "Your KiloClaw Trial Ends in 2 Days" | "Your KiloClaw Trial Expires Tomorrow" | "Your KiloClaw Trial Has Ended" | "Your KiloClaw Subscription Has Ended" | "Action Required: KiloClaw Payment Overdue" | "Your KiloClaw Instance Will Be Deleted in 2 Days" | "Your KiloClaw Instance Has Been Deleted" | "Your KiloClaw Earlybird Access Ends Soon" | "Your KiloClaw Earlybird Access Expires Tomorrow" | "Your KiloClaw Instance Is Ready";
                }[];
                meta: object;
            }>;
            getPreview: _trpc_server.TRPCQueryProcedure<{
                input: {
                    template: "orgSubscription" | "orgRenewed" | "orgCancelled" | "orgSSOUserJoined" | "orgInvitation" | "magicLink" | "balanceAlert" | "autoTopUpFailed" | "ossInviteNewUser" | "ossInviteExistingUser" | "ossExistingOrgProvisioned" | "deployFailed" | "clawTrialEndingSoon" | "clawTrialExpiresTomorrow" | "clawSuspendedTrial" | "clawSuspendedSubscription" | "clawSuspendedPayment" | "clawDestructionWarning" | "clawInstanceDestroyed" | "clawEarlybirdEndingSoon" | "clawEarlybirdExpiresTomorrow" | "clawInstanceReady";
                };
                output: {
                    subject: "Welcome to Kilo for Teams!" | "Kilo: Your Teams Subscription Renewal" | "Kilo: Your Teams Subscription is Cancelled" | "Kilo: New SSO User Joined Your Organization" | "Kilo: Teams Invitation" | "Sign in to Kilo Code" | "Kilo: Low Balance Alert" | "Kilo: Auto Top-Up Failed" | "Kilo: OSS Sponsorship Offer" | "Kilo: Your Deployment Failed" | "Your KiloClaw Trial Ends in 2 Days" | "Your KiloClaw Trial Expires Tomorrow" | "Your KiloClaw Trial Has Ended" | "Your KiloClaw Subscription Has Ended" | "Action Required: KiloClaw Payment Overdue" | "Your KiloClaw Instance Will Be Deleted in 2 Days" | "Your KiloClaw Instance Has Been Deleted" | "Your KiloClaw Earlybird Access Ends Soon" | "Your KiloClaw Earlybird Access Expires Tomorrow" | "Your KiloClaw Instance Is Ready";
                    html: string;
                };
                meta: object;
            }>;
            sendTest: _trpc_server.TRPCMutationProcedure<{
                input: {
                    template: "orgSubscription" | "orgRenewed" | "orgCancelled" | "orgSSOUserJoined" | "orgInvitation" | "magicLink" | "balanceAlert" | "autoTopUpFailed" | "ossInviteNewUser" | "ossInviteExistingUser" | "ossExistingOrgProvisioned" | "deployFailed" | "clawTrialEndingSoon" | "clawTrialExpiresTomorrow" | "clawSuspendedTrial" | "clawSuspendedSubscription" | "clawSuspendedPayment" | "clawDestructionWarning" | "clawInstanceDestroyed" | "clawEarlybirdEndingSoon" | "clawEarlybirdExpiresTomorrow" | "clawInstanceReady";
                    recipient: string;
                };
                output: {
                    recipient: string;
                };
                meta: object;
            }>;
        }>>;
        botRequests: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            weeklyActiveUsers: _trpc_server.TRPCQueryProcedure<{
                input: {
                    days?: number | undefined;
                };
                output: {
                    week: string;
                    activeUsers: number;
                }[];
                meta: object;
            }>;
            newUsersPerDay: _trpc_server.TRPCQueryProcedure<{
                input: {
                    days?: number | undefined;
                };
                output: {
                    date: string;
                    newUsers: number;
                }[];
                meta: object;
            }>;
            dailyUsage: _trpc_server.TRPCQueryProcedure<{
                input: {
                    days?: number | undefined;
                };
                output: {
                    date: string;
                    platform: string;
                    totalRequests: number;
                }[];
                meta: object;
            }>;
            list: _trpc_server.TRPCQueryProcedure<{
                input: {
                    page?: number | undefined;
                    limit?: 100 | 50 | 10 | 25 | undefined;
                };
                output: {
                    requests: {
                        id: string;
                        userEmail: string;
                        userName: string;
                        organizationName: string | null;
                        userMessage: string;
                        platform: string;
                        status: BotRequestStatus;
                        createdAt: string;
                    }[];
                    pagination: {
                        page: number;
                        limit: 100 | 50 | 10 | 25;
                        total: number;
                        totalPages: number;
                    };
                };
                meta: object;
            }>;
            getById: _trpc_server.TRPCQueryProcedure<{
                input: {
                    id: string;
                };
                output: {
                    id: string;
                    userEmail: string;
                    userName: string;
                    userId: string;
                    organizationId: string | null;
                    organizationName: string | null;
                    platform: string;
                    platformThreadId: string;
                    platformMessageId: string | null;
                    userMessage: string;
                    status: BotRequestStatus;
                    errorMessage: string | null;
                    modelUsed: string | null;
                    steps: BotRequestStep[] | null;
                    cloudAgentSessionId: string | null;
                    responseTimeMs: number | null;
                    createdAt: string;
                    updatedAt: string;
                };
                meta: object;
            }>;
        }>>;
        gastown: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getUserTowns: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    id: string;
                    name: string;
                    owner_user_id: string;
                    created_at: string;
                    updated_at: string;
                }[];
                meta: object;
            }>;
            getUserRigs: _trpc_server.TRPCQueryProcedure<{
                input: {
                    userId: string;
                };
                output: {
                    id: string;
                    town_id: string;
                    name: string;
                    git_url: string;
                    default_branch: string;
                    platform_integration_id: string | null;
                    created_at: string;
                    updated_at: string;
                }[];
                meta: object;
            }>;
            getTownHealth: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                };
                output: {
                    alarm: {
                        nextFireAt: string | null;
                        intervalMs: number;
                        intervalLabel: string;
                    };
                    agents: {
                        working: number;
                        idle: number;
                        stalled: number;
                        dead: number;
                        total: number;
                    };
                    beads: {
                        open: number;
                        inProgress: number;
                        failed: number;
                        triageRequests: number;
                    };
                    patrol: {
                        guppWarnings: number;
                        guppEscalations: number;
                        stalledAgents: number;
                        orphanedHooks: number;
                    };
                    recentEvents: {
                        time: string;
                        type: string;
                        message: string;
                    }[];
                } | null;
                meta: object;
            }>;
            listBeads: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                    status?: "failed" | "open" | "in_progress" | "closed" | undefined;
                    type?: "message" | "issue" | "agent" | "escalation" | "merge_request" | "convoy" | "molecule" | undefined;
                    limit?: number | undefined;
                };
                output: {
                    bead_id: string;
                    type: "message" | "issue" | "agent" | "escalation" | "merge_request" | "convoy" | "molecule";
                    status: "failed" | "open" | "in_progress" | "closed";
                    title: string;
                    body: string | null;
                    rig_id: string | null;
                    parent_bead_id: string | null;
                    assignee_agent_bead_id: string | null;
                    priority: "critical" | "high" | "medium" | "low";
                    labels: string[];
                    metadata: Record<string, unknown>;
                    created_by: string | null;
                    created_at: string;
                    updated_at: string;
                    closed_at: string | null;
                }[];
                meta: object;
            }>;
            getBead: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                    beadId: string;
                };
                output: {
                    bead_id: string;
                    type: "message" | "issue" | "agent" | "escalation" | "merge_request" | "convoy" | "molecule";
                    status: "failed" | "open" | "in_progress" | "closed";
                    title: string;
                    body: string | null;
                    rig_id: string | null;
                    parent_bead_id: string | null;
                    assignee_agent_bead_id: string | null;
                    priority: "critical" | "high" | "medium" | "low";
                    labels: string[];
                    metadata: Record<string, unknown>;
                    created_by: string | null;
                    created_at: string;
                    updated_at: string;
                    closed_at: string | null;
                } | null;
                meta: object;
            }>;
            getBeadEvents: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                    beadId?: string | undefined;
                    since?: string | undefined;
                    limit?: number | undefined;
                };
                output: {
                    bead_event_id: string;
                    bead_id: string;
                    agent_id: string | null;
                    event_type: string;
                    old_value: string | null;
                    new_value: string | null;
                    metadata: Record<string, unknown>;
                    created_at: string;
                    rig_id?: string | undefined;
                    rig_name?: string | undefined;
                }[];
                meta: object;
            }>;
            listAgents: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                };
                output: {
                    id: string;
                    rig_id: string | null;
                    role: string;
                    name: string;
                    identity: string;
                    status: string;
                    current_hook_bead_id: string | null;
                    dispatch_attempts: number;
                    last_activity_at: string | null;
                    created_at: string;
                    checkpoint?: unknown;
                }[];
                meta: object;
            }>;
            getAgentEvents: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                    agentId: string;
                    afterId?: number | undefined;
                    limit?: number | undefined;
                };
                output: unknown[];
                meta: object;
            }>;
            listDispatchAttempts: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                    beadId?: string | undefined;
                    agentId?: string | undefined;
                };
                output: {
                    id: string;
                    bead_id: string | null;
                    agent_id: string | null;
                    attempted_at: string;
                    success: boolean;
                    error_message: string | null;
                }[];
                meta: object;
            }>;
            listContainerEvents: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                    since?: string | undefined;
                };
                output: {
                    id: string;
                    event_type: string;
                    created_at: string;
                    data?: Record<string, unknown> | undefined;
                }[];
                meta: object;
            }>;
            listCredentialEvents: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                    rigId?: string | undefined;
                };
                output: {
                    id: string;
                    rig_id: string | null;
                    event_type: string;
                    created_at: string;
                    data?: Record<string, unknown> | undefined;
                }[];
                meta: object;
            }>;
            listAuditLog: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                };
                output: {
                    id: string;
                    admin_user_id: string;
                    action: string;
                    target_type: string | null;
                    target_id: string | null;
                    performed_at: string;
                    detail?: Record<string, unknown> | undefined;
                }[];
                meta: object;
            }>;
            getTownConfig: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                };
                output: {
                    env_vars: Record<string, string>;
                    git_auth: {
                        github_token?: string | undefined;
                        gitlab_token?: string | undefined;
                        gitlab_instance_url?: string | undefined;
                        platform_integration_id?: string | undefined;
                    };
                    merge_strategy: "direct" | "pr";
                    owner_user_id?: string | undefined;
                    kilocode_token?: string | undefined;
                    default_model?: string | null | undefined;
                    role_models?: {
                        mayor?: string | null | undefined;
                        refinery?: string | null | undefined;
                        polecat?: string | null | undefined;
                    } | null | undefined;
                    small_model?: string | null | undefined;
                    max_polecats_per_rig?: number | undefined;
                    refinery?: {
                        gates: string[];
                        auto_merge: boolean;
                        require_clean_merge: boolean;
                    } | undefined;
                    alarm_interval_active?: number | undefined;
                    alarm_interval_idle?: number | undefined;
                    container?: {
                        sleep_after_minutes?: number | undefined;
                    } | undefined;
                    staged_convoys_default?: boolean | undefined;
                };
                meta: object;
            }>;
            getConvoyStatus: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                    convoyId: string;
                };
                output: {
                    id: string;
                    title: string;
                    status: "active" | "landed";
                    total_beads: number;
                    closed_beads: number;
                    created_by: string | null;
                    created_at: string;
                    landed_at: string | null;
                    feature_branch: string | null;
                    merge_mode: string | null;
                    beads: {
                        bead_id: string;
                        title: string;
                        status: string;
                        rig_id: string | null;
                        assignee_agent_name: string | null;
                    }[];
                    dependency_edges: {
                        bead_id: string;
                        depends_on_bead_id: string;
                    }[];
                } | null;
                meta: object;
            }>;
            listConvoys: _trpc_server.TRPCQueryProcedure<{
                input: {
                    townId: string;
                };
                output: {
                    id: string;
                    title: string;
                    status: "active" | "landed";
                    total_beads: number;
                    closed_beads: number;
                    created_by: string | null;
                    created_at: string;
                    landed_at: string | null;
                    feature_branch: string | null;
                    merge_mode: string | null;
                    beads: {
                        bead_id: string;
                        title: string;
                        status: string;
                        rig_id: string | null;
                        assignee_agent_name: string | null;
                    }[];
                    dependency_edges: {
                        bead_id: string;
                        depends_on_bead_id: string;
                    }[];
                }[];
                meta: object;
            }>;
            forceResetAgent: _trpc_server.TRPCMutationProcedure<{
                input: {
                    townId: string;
                    agentId: string;
                };
                output: void;
                meta: object;
            }>;
            forceCloseBead: _trpc_server.TRPCMutationProcedure<{
                input: {
                    townId: string;
                    beadId: string;
                };
                output: void;
                meta: object;
            }>;
            forceFailBead: _trpc_server.TRPCMutationProcedure<{
                input: {
                    townId: string;
                    beadId: string;
                };
                output: void;
                meta: object;
            }>;
            forceRestartContainer: _trpc_server.TRPCMutationProcedure<{
                input: {
                    townId: string;
                };
                output: void;
                meta: object;
            }>;
            forceRetryReview: _trpc_server.TRPCMutationProcedure<{
                input: {
                    townId: string;
                    entryId: string;
                };
                output: never;
                meta: object;
            }>;
            forceRefreshCredentials: _trpc_server.TRPCMutationProcedure<{
                input: {
                    townId: string;
                    rigId: string;
                };
                output: never;
                meta: object;
            }>;
            updateTownConfig: _trpc_server.TRPCMutationProcedure<{
                input: {
                    townId: string;
                    update: {
                        env_vars?: Record<string, string> | undefined;
                        git_auth?: {
                            github_token?: string | undefined;
                            gitlab_token?: string | undefined;
                            gitlab_instance_url?: string | undefined;
                            platform_integration_id?: string | undefined;
                        } | undefined;
                        owner_user_id?: string | undefined;
                        kilocode_token?: string | undefined;
                        default_model?: string | null | undefined;
                        role_models?: {
                            mayor?: string | null | undefined;
                            refinery?: string | null | undefined;
                            polecat?: string | null | undefined;
                        } | null | undefined;
                        small_model?: string | null | undefined;
                        max_polecats_per_rig?: number | undefined;
                        merge_strategy?: "direct" | "pr" | undefined;
                        refinery?: {
                            gates: string[];
                            auto_merge: boolean;
                            require_clean_merge: boolean;
                        } | undefined;
                        alarm_interval_active?: number | undefined;
                        alarm_interval_idle?: number | undefined;
                        container?: {
                            sleep_after_minutes?: number | undefined;
                        } | undefined;
                        staged_convoys_default?: boolean | undefined;
                    };
                };
                output: {
                    env_vars: Record<string, string>;
                    git_auth: {
                        github_token?: string | undefined;
                        gitlab_token?: string | undefined;
                        gitlab_instance_url?: string | undefined;
                        platform_integration_id?: string | undefined;
                    };
                    merge_strategy: "direct" | "pr";
                    owner_user_id?: string | undefined;
                    kilocode_token?: string | undefined;
                    default_model?: string | null | undefined;
                    role_models?: {
                        mayor?: string | null | undefined;
                        refinery?: string | null | undefined;
                        polecat?: string | null | undefined;
                    } | null | undefined;
                    small_model?: string | null | undefined;
                    max_polecats_per_rig?: number | undefined;
                    refinery?: {
                        gates: string[];
                        auto_merge: boolean;
                        require_clean_merge: boolean;
                    } | undefined;
                    alarm_interval_active?: number | undefined;
                    alarm_interval_idle?: number | undefined;
                    container?: {
                        sleep_after_minutes?: number | undefined;
                    } | undefined;
                    staged_convoys_default?: boolean | undefined;
                };
                meta: object;
            }>;
        }>>;
    }>>;
    codeIndexing: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        search: _trpc_server.TRPCQueryProcedure<{
            input: {
                query: string;
                projectId: string;
                organizationId?: string | null | undefined;
                path?: string | undefined;
                preferBranch?: string | undefined;
                fallbackBranch?: string | undefined;
                excludeFiles?: string[] | undefined;
            };
            output: {
                id: string;
                filePath: string;
                startLine: number;
                endLine: number;
                score: number;
                gitBranch: string;
                fromPreferredBranch: boolean;
            }[];
            meta: object;
        }>;
        delete: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
                organizationId?: string | null | undefined;
                gitBranch?: string | undefined;
                filePaths?: string[] | undefined;
            };
            output: {
                success: boolean;
                deletedFiles: number;
            };
            meta: object;
        }>;
        getManifest: _trpc_server.TRPCQueryProcedure<{
            input: {
                projectId: string;
                gitBranch: string;
                organizationId?: string | null | undefined;
            };
            output: {
                organizationId: string;
                projectId: string;
                gitBranch: string;
                files: Record<string, string>;
                totalFiles: number;
                lastUpdated: string;
                totalLines: number;
                totalAILines: number;
                percentageOfAILines: number;
            };
            meta: object;
        }>;
        getRecentSearches: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
            };
            output: {
                id: string;
                query: string;
                project_id: string;
                created_at: string;
                kilo_user_id: string;
                results_count: number;
                metadata: any;
            }[];
            meta: object;
        }>;
        getOrganizationStats: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | null | undefined;
                overrideUser?: string | undefined;
            };
            output: {
                project_id: string;
                chunk_count: number;
                file_count: number;
                percentage_of_org: number;
                size_kb: number;
                last_modified: string;
                branches: {
                    branch_name: string;
                    last_modified: string;
                    file_count: number;
                    chunk_count: number;
                    size_kb: number;
                }[];
            }[];
            meta: object;
        }>;
        getProjectFiles: _trpc_server.TRPCQueryProcedure<{
            input: {
                projectId: string;
                organizationId?: string | null | undefined;
                gitBranch?: string | undefined;
                fileSearch?: string | undefined;
                page?: number | undefined;
                pageSize?: number | undefined;
                overrideUser?: string | undefined;
            };
            output: {
                files: {
                    file_path: string;
                    chunk_count: number;
                    size_kb: number;
                    branches: string[];
                    total_lines: number;
                    total_ai_lines: number;
                    percentage_of_ai_lines: number;
                }[];
                total: number;
                page: number;
                pageSize: number;
                totalPages: number;
                totalLines: number;
                totalAILines: number;
                percentageOfAILines: number;
            };
            meta: object;
        }>;
        deleteBeforeDate: _trpc_server.TRPCMutationProcedure<{
            input: {
                beforeDate: Date;
                organizationId?: string | null | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        admin: _trpc_server.TRPCBuiltRouter<{
            ctx: TRPCContext;
            meta: object;
            errorShape: {
                data: {
                    zodError: {
                        formErrors: string[];
                        fieldErrors: {};
                    } | null;
                    upstreamCode: string | undefined;
                    code: _trpc_server.TRPC_ERROR_CODE_KEY;
                    httpStatus: number;
                    path?: string;
                    stack?: string;
                };
                message: string;
                code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
            };
            transformer: false;
        }, _trpc_server.TRPCDecorateCreateRouterOptions<{
            getSummaryStats: _trpc_server.TRPCQueryProcedure<{
                input: {
                    page?: number | undefined;
                    pageSize?: number | undefined;
                    sortBy?: "chunk_count" | "organization_name" | "project_count" | "branch_count" | "percentage_of_rows" | "size_kb" | "last_modified" | undefined;
                    sortOrder?: "asc" | "desc" | undefined;
                };
                output: {
                    items: {
                        organization_id: string;
                        organization_name: string;
                        chunk_count: number;
                        project_count: number;
                        branch_count: number;
                        percentage_of_rows: number;
                        size_kb: number;
                        last_modified: string;
                    }[];
                    total: number;
                    page: number;
                    pageSize: number;
                    totalPages: number;
                };
                meta: object;
            }>;
            getUserSummaryStats: _trpc_server.TRPCQueryProcedure<{
                input: {
                    page?: number | undefined;
                    pageSize?: number | undefined;
                    sortBy?: "chunk_count" | "user_email" | "project_count" | "branch_count" | "percentage_of_rows" | "size_kb" | "last_modified" | undefined;
                    sortOrder?: "asc" | "desc" | undefined;
                };
                output: {
                    items: {
                        kilo_user_id: string;
                        user_email: string;
                        chunk_count: number;
                        project_count: number;
                        branch_count: number;
                        percentage_of_rows: number;
                        size_kb: number;
                        last_modified: string;
                    }[];
                    total: number;
                    page: number;
                    pageSize: number;
                    totalPages: number;
                };
                meta: object;
            }>;
            getClusterStatus: _trpc_server.TRPCQueryProcedure<{
                input: void;
                output: {
                    totalPostgresRows: number;
                    distribution: string;
                    distributionVersion: string;
                    isDocker: boolean;
                    cpuCores: number;
                    totalRamBytes: number;
                    totalDiskBytes: number;
                    cpuFlags: string;
                    memoryActiveBytes: number;
                    memoryAllocatedBytes: number;
                    memoryMetadataBytes: number;
                    memoryResidentBytes: number;
                    memoryRetainedBytes: number;
                    mainCollectionPoints: number;
                    mainCollectionOptimizersStatus: string;
                    clusterRole: string;
                    clusterPeers: number;
                    clusterPendingOperations: number;
                    consensusStatus: string;
                    qdrantVersion: string;
                    uptime: string;
                };
                meta: object;
            }>;
        }>>;
    }>>;
    deployments: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        checkDeploymentEligibility: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                canCreateDeployment: boolean;
            };
            meta: object;
        }>;
        listDeployments: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                success: boolean;
                data: {
                    deployment: {
                        id: string;
                        created_by_user_id: string | null;
                        owned_by_user_id: string | null;
                        owned_by_organization_id: string | null;
                        deployment_slug: string;
                        internal_worker_name: string;
                        repository_source: string;
                        branch: string;
                        deployment_url: string;
                        platform_integration_id: string | null;
                        source_type: "github" | "git" | "app-builder";
                        git_auth_token: string | null;
                        created_at: string;
                        last_deployed_at: string | null;
                        last_build_id: string;
                        threat_status: "pending_scan" | "safe" | "flagged" | null;
                        created_from: "app-builder" | "deploy" | null;
                    };
                    latestBuild: {
                        id: string;
                        deployment_id: string;
                        status: "failed" | "queued" | "building" | "deploying" | "deployed" | "cancelled";
                        started_at: string | null;
                        completed_at: string | null;
                        created_at: string;
                    } | null;
                    appBuilderProjectId: string | null;
                }[];
            };
            meta: object;
        }>;
        getDeployment: _trpc_server.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: {
                success: boolean;
                deployment: {
                    id: string;
                    created_by_user_id: string | null;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    deployment_slug: string;
                    internal_worker_name: string;
                    repository_source: string;
                    branch: string;
                    deployment_url: string;
                    platform_integration_id: string | null;
                    source_type: "github" | "git" | "app-builder";
                    git_auth_token: string | null;
                    created_at: string;
                    last_deployed_at: string | null;
                    last_build_id: string;
                    threat_status: "pending_scan" | "safe" | "flagged" | null;
                    created_from: "app-builder" | "deploy" | null;
                };
                latestBuild: {
                    id: string;
                    deployment_id: string;
                    status: "failed" | "queued" | "building" | "deploying" | "deployed" | "cancelled";
                    started_at: string | null;
                    completed_at: string | null;
                    created_at: string;
                } | null;
                appBuilderProjectId: string | null;
            };
            meta: object;
        }>;
        getBuildEvents: _trpc_server.TRPCQueryProcedure<{
            input: {
                deploymentId: string;
                buildId: string;
                limit?: number | undefined;
                afterEventId?: number | undefined;
            };
            output: ({
                id: number;
                ts: string;
                type: "log";
                payload: {
                    message: string;
                };
            } | {
                id: number;
                ts: string;
                type: "status_change";
                payload: {
                    status: "failed" | "queued" | "building" | "deploying" | "deployed" | "cancelled";
                };
            })[];
            meta: object;
        }>;
        deleteDeployment: _trpc_server.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        cancelBuild: _trpc_server.TRPCMutationProcedure<{
            input: {
                deploymentId: string;
                buildId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        redeploy: _trpc_server.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: void;
            meta: object;
        }>;
        createDeployment: _trpc_server.TRPCMutationProcedure<{
            input: {
                platformIntegrationId: string;
                repositoryFullName: string;
                branch: string;
                envVars?: {
                    key: string;
                    value: string;
                    isSecret: boolean;
                }[] | undefined;
            };
            output: CreateDeploymentResult;
            meta: object;
        }>;
        checkSlugAvailability: _trpc_server.TRPCQueryProcedure<{
            input: {
                slug: string;
            };
            output: CheckSlugAvailabilityResult;
            meta: object;
        }>;
        renameDeployment: _trpc_server.TRPCMutationProcedure<{
            input: {
                deploymentId: string;
                newSlug: string;
            };
            output: RenameDeploymentResult;
            meta: object;
        }>;
        setEnvVar: _trpc_server.TRPCMutationProcedure<{
            input: {
                key: string;
                value: string;
                isSecret: boolean;
                deploymentId: string;
            };
            output: void;
            meta: object;
        }>;
        deleteEnvVar: _trpc_server.TRPCMutationProcedure<{
            input: {
                deploymentId: string;
                key: string;
            };
            output: void;
            meta: object;
        }>;
        listEnvVars: _trpc_server.TRPCQueryProcedure<{
            input: {
                deploymentId: string;
            };
            output: {
                key: string;
                value: string;
                isSecret: boolean;
                createdAt: string;
                updatedAt: string;
            }[];
            meta: object;
        }>;
        renameEnvVar: _trpc_server.TRPCMutationProcedure<{
            input: {
                deploymentId: string;
                oldKey: string;
                newKey: string;
            };
            output: void;
            meta: object;
        }>;
    }>>;
    cliSessions: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        list: _trpc_server.TRPCQueryProcedure<{
            input: {
                cursor?: string | undefined;
                limit?: number | undefined;
                createdOnPlatform?: string | string[] | undefined;
                orderBy?: "updated_at" | "created_at" | undefined;
                organizationId?: string | null | undefined;
            };
            output: {
                cliSessions: {
                    readonly session_id: string;
                    readonly title: string;
                    readonly git_url: string | null;
                    readonly cloud_agent_session_id: string | null;
                    readonly created_on_platform: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                    readonly version: number;
                    readonly organization_id: string | null;
                    readonly last_mode: string | null;
                    readonly last_model: string | null;
                    readonly parent_session_id: string | null;
                }[];
                nextCursor: string | null;
            };
            meta: object;
        }>;
        search: _trpc_server.TRPCQueryProcedure<{
            input: {
                search_string: string;
                limit?: number | undefined;
                offset?: number | undefined;
                createdOnPlatform?: string | string[] | undefined;
                organizationId?: string | null | undefined;
            };
            output: {
                results: {
                    readonly session_id: string;
                    readonly title: string;
                    readonly git_url: string | null;
                    readonly cloud_agent_session_id: string | null;
                    readonly created_on_platform: string;
                    readonly created_at: string;
                    readonly updated_at: string;
                    readonly version: number;
                    readonly organization_id: string | null;
                    readonly last_mode: string | null;
                    readonly last_model: string | null;
                    readonly parent_session_id: string | null;
                }[];
                total: number;
                limit: number;
                offset: number;
            };
            meta: object;
        }>;
        create: _trpc_server.TRPCMutationProcedure<{
            input: {
                created_on_platform: string;
                title?: string | undefined;
                git_url?: string | undefined;
                version?: number | undefined;
                last_mode?: string | null | undefined;
                last_model?: string | null | undefined;
                organization_id?: string | null | undefined;
                parent_session_id?: string | null | undefined;
                cloud_agent_session_id?: string | undefined;
            };
            output: {
                readonly session_id: string;
                readonly title: string;
                readonly git_url: string | null;
                readonly cloud_agent_session_id: string | null;
                readonly created_on_platform: string;
                readonly created_at: string;
                readonly updated_at: string;
                readonly version: number;
                readonly organization_id: string | null;
                readonly last_mode: string | null;
                readonly last_model: string | null;
                readonly parent_session_id: string | null;
            };
            meta: object;
        }>;
        createV2: _trpc_server.TRPCMutationProcedure<{
            input: {
                created_on_platform: string;
                title?: string | undefined;
                git_url?: string | undefined;
                version?: number | undefined;
                last_mode?: string | null | undefined;
                last_model?: string | null | undefined;
                organization_id?: string | null | undefined;
                parent_session_id?: string | null | undefined;
                cloud_agent_session_id?: string | undefined;
            };
            output: {
                readonly session_id: string;
                readonly title: string;
                readonly git_url: string | null;
                readonly cloud_agent_session_id: string | null;
                readonly created_on_platform: string;
                readonly created_at: string;
                readonly updated_at: string;
                readonly version: number;
                readonly organization_id: string | null;
                readonly last_mode: string | null;
                readonly last_model: string | null;
                readonly parent_session_id: string | null;
            };
            meta: object;
        }>;
        get: _trpc_server.TRPCQueryProcedure<{
            input: {
                session_id: string;
                include_blob_urls?: boolean | undefined;
            };
            output: {
                session_id: string;
                kilo_user_id: string;
                title: string;
                created_on_platform: string;
                api_conversation_history_blob_url: string | null;
                task_metadata_blob_url: string | null;
                ui_messages_blob_url: string | null;
                git_state_blob_url: string | null;
                git_url: string | null;
                forked_from: string | null;
                parent_session_id: string | null;
                cloud_agent_session_id: string | null;
                organization_id: string | null;
                last_mode: string | null;
                last_model: string | null;
                version: number;
                created_at: string;
                updated_at: string;
            };
            meta: object;
        }>;
        update: _trpc_server.TRPCMutationProcedure<{
            input: {
                session_id: string;
                title?: string | undefined;
                git_url?: string | undefined;
                version?: number | undefined;
                last_mode?: string | null | undefined;
                last_model?: string | null | undefined;
                organization_id?: string | null | undefined;
            };
            output: {
                readonly session_id: string;
                readonly title: string;
                readonly git_url: string | null;
                readonly cloud_agent_session_id: string | null;
                readonly created_on_platform: string;
                readonly created_at: string;
                readonly updated_at: string;
                readonly version: number;
                readonly organization_id: string | null;
                readonly last_mode: string | null;
                readonly last_model: string | null;
                readonly parent_session_id: string | null;
            };
            meta: object;
        }>;
        delete: _trpc_server.TRPCMutationProcedure<{
            input: {
                session_id: string;
            };
            output: {
                success: boolean;
                session_id: string;
            };
            meta: object;
        }>;
        share: _trpc_server.TRPCMutationProcedure<{
            input: {
                session_id: string;
                shared_state: CliSessionSharedState;
            };
            output: {
                share_id: string;
                session_id: string | null;
            };
            meta: object;
        }>;
        fork: _trpc_server.TRPCMutationProcedure<{
            input: {
                share_or_session_id: string;
                created_on_platform: string;
            };
            output: {
                readonly session_id: string;
                readonly title: string;
                readonly git_url: string | null;
                readonly cloud_agent_session_id: string | null;
                readonly created_on_platform: string;
                readonly created_at: string;
                readonly updated_at: string;
                readonly version: number;
                readonly organization_id: string | null;
                readonly last_mode: string | null;
                readonly last_model: string | null;
                readonly parent_session_id: string | null;
            };
            meta: object;
        }>;
        linkCloudAgent: _trpc_server.TRPCMutationProcedure<{
            input: {
                kilo_session_id: string;
                cloud_agent_session_id: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        getByCloudAgentSessionId: _trpc_server.TRPCQueryProcedure<{
            input: {
                cloud_agent_session_id: string;
            };
            output: {
                readonly session_id: string;
                readonly title: string;
                readonly git_url: string | null;
                readonly cloud_agent_session_id: string | null;
                readonly created_on_platform: string;
                readonly created_at: string;
                readonly updated_at: string;
                readonly version: number;
                readonly organization_id: string | null;
                readonly last_mode: string | null;
                readonly last_model: string | null;
                readonly parent_session_id: string | null;
            };
            meta: object;
        }>;
        getSessionMessages: _trpc_server.TRPCQueryProcedure<{
            input: {
                session_id: string;
            };
            output: {
                messages: {};
            };
            meta: object;
        }>;
        getSessionGitState: _trpc_server.TRPCQueryProcedure<{
            input: {
                session_id: string;
            };
            output: unknown;
            meta: object;
        }>;
        getSessionApiConversationHistory: _trpc_server.TRPCQueryProcedure<{
            input: {
                session_id: string;
            };
            output: {
                history: {};
            };
            meta: object;
        }>;
        forkForReview: _trpc_server.TRPCMutationProcedure<{
            input: {
                review_id: string;
                created_on_platform: string;
            };
            output: {
                readonly session_id: string;
                readonly title: string;
                readonly git_url: string | null;
                readonly cloud_agent_session_id: string | null;
                readonly created_on_platform: string;
                readonly created_at: string;
                readonly updated_at: string;
                readonly version: number;
                readonly organization_id: string | null;
                readonly last_mode: string | null;
                readonly last_model: string | null;
                readonly parent_session_id: string | null;
            };
            meta: object;
        }>;
        shareForWebhookTrigger: _trpc_server.TRPCMutationProcedure<{
            input: {
                kilo_session_id: string;
                trigger_id: string;
                organization_id?: string | undefined;
            };
            output: {
                share_id: string;
                session_id: string | null;
            };
            meta: object;
        }>;
    }>>;
    cliSessionsV2: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        list: _trpc_server.TRPCQueryProcedure<{
            input: {
                cursor?: string | undefined;
                limit?: number | undefined;
                orderBy?: "updated_at" | "created_at" | undefined;
                includeChildren?: boolean | undefined;
                gitUrl?: string | undefined;
                version?: number | undefined;
            };
            output: {
                cliSessions: {
                    readonly session_id: string;
                    readonly title: string | null;
                    readonly cloud_agent_session_id: string | null;
                    readonly created_at: string;
                    readonly updated_at: string;
                    readonly version: number;
                }[];
                nextCursor: string | null;
            };
            meta: object;
        }>;
        get: _trpc_server.TRPCQueryProcedure<{
            input: {
                session_id: string;
            };
            output: {
                session_id: string;
                kilo_user_id: string;
                version: number;
                title: string | null;
                public_id: string | null;
                parent_session_id: string | null;
                organization_id: string | null;
                cloud_agent_session_id: string | null;
                created_on_platform: string;
                git_url: string | null;
                git_branch: string | null;
                created_at: string;
                updated_at: string;
            };
            meta: object;
        }>;
        getByCloudAgentSessionId: _trpc_server.TRPCQueryProcedure<{
            input: {
                cloud_agent_session_id: string;
            };
            output: {
                readonly session_id: string;
                readonly title: string | null;
                readonly cloud_agent_session_id: string | null;
                readonly created_at: string;
                readonly updated_at: string;
                readonly version: number;
            };
            meta: object;
        }>;
        getSessionMessages: _trpc_server.TRPCQueryProcedure<{
            input: {
                session_id: string;
            };
            output: {
                messages: {
                    [x: string]: unknown;
                    info: {
                        [x: string]: unknown;
                        id: string;
                    };
                    parts: {
                        [x: string]: unknown;
                        id: string;
                    }[];
                }[];
            };
            meta: object;
        }>;
        getWithRuntimeState: _trpc_server.TRPCQueryProcedure<{
            input: {
                session_id: string;
            };
            output: {
                session_id: string;
                title: string | null;
                cloud_agent_session_id: string | null;
                organization_id: string | null;
                git_url: string | null;
                git_branch: string | null;
                created_at: Date;
                updated_at: Date;
                version: number;
                runtimeState: {
                    sessionId: string;
                    userId: string;
                    execution: {
                        id: string;
                        status: "failed" | "completed" | "interrupted" | "pending" | "running";
                        startedAt: number;
                        lastHeartbeat: number | null;
                        processId: string | null;
                        error: string | null;
                        health: "unknown" | "stale" | "healthy";
                    } | null;
                    timestamp: number;
                    version: number;
                    kiloSessionId?: string | undefined;
                    orgId?: string | undefined;
                    sandboxId?: string | undefined;
                    githubRepo?: string | undefined;
                    gitUrl?: string | undefined;
                    platform?: "github" | "gitlab" | undefined;
                    prompt?: string | undefined;
                    mode?: "custom" | "plan" | "code" | "architect" | "ask" | "debug" | "orchestrator" | "build" | undefined;
                    model?: string | undefined;
                    autoCommit?: boolean | undefined;
                    upstreamBranch?: string | undefined;
                    envVarCount?: number | undefined;
                    setupCommandCount?: number | undefined;
                    mcpServerCount?: number | undefined;
                    preparedAt?: number | undefined;
                    initiatedAt?: number | undefined;
                    callbackTarget?: {
                        url: string;
                        headers?: Record<string, string> | undefined;
                    } | undefined;
                } | null;
            };
            meta: object;
        }>;
        delete: _trpc_server.TRPCMutationProcedure<{
            input: {
                session_id: string;
            };
            output: {
                success: boolean;
                session_id: string;
            };
            meta: object;
        }>;
        share: _trpc_server.TRPCMutationProcedure<{
            input: {
                session_id: string;
            };
            output: {
                public_id: string;
            };
            meta: object;
        }>;
        shareForWebhookTrigger: _trpc_server.TRPCMutationProcedure<{
            input: {
                kilo_session_id: string;
                trigger_id: string;
                organization_id?: string | undefined;
            };
            output: {
                share_id: string;
                session_id: string;
            };
            meta: object;
        }>;
    }>>;
    githubApps: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        listIntegrations: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                id: string;
                owned_by_organization_id: string | null;
                owned_by_user_id: string | null;
                created_by_user_id: string | null;
                platform: string;
                integration_type: string;
                platform_installation_id: string | null;
                platform_account_id: string | null;
                platform_account_login: string | null;
                permissions: IntegrationPermissions | null;
                scopes: string[] | null;
                repository_access: string | null;
                repositories: PlatformRepository[] | null;
                repositories_synced_at: string | null;
                metadata: unknown;
                kilo_requester_user_id: string | null;
                platform_requester_account_id: string | null;
                integration_status: string | null;
                suspended_at: string | null;
                suspended_by: string | null;
                github_app_type: "standard" | "lite" | null;
                installed_at: string;
                created_at: string;
                updated_at: string;
            }[];
            meta: object;
        }>;
        getInstallation: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                installed: boolean;
                installation: null;
            } | {
                installed: boolean;
                installation: {
                    installationId: string | null;
                    accountId: string | null;
                    accountLogin: string | null;
                    accountType: string | undefined;
                    targetType: string | undefined;
                    permissions: IntegrationPermissions | null;
                    events: string[] | null;
                    repositorySelection: string | null;
                    repositories: PlatformRepository[] | null;
                    suspendedAt: string | null;
                    suspendedBy: string | null;
                    installedAt: string;
                    status: string | null;
                };
            };
            meta: object;
        }>;
        checkUserPendingInstallation: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                hasPending: boolean;
                pendingOrganizationId: string | null;
            };
            meta: object;
        }>;
        uninstallApp: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        listRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                integrationId: string;
                organizationId?: string | undefined;
                forceRefresh?: boolean | undefined;
            };
            output: {
                repositories: PlatformRepository[];
                syncedAt: string;
            };
            meta: object;
        }>;
        listBranches: _trpc_server.TRPCQueryProcedure<{
            input: {
                integrationId: string;
                repositoryFullName: string;
                organizationId?: string | undefined;
            };
            output: {
                branches: {
                    name: string;
                    isDefault: boolean;
                }[];
            };
            meta: object;
        }>;
        cancelPendingInstallation: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        refreshInstallation: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        devAddInstallation: _trpc_server.TRPCMutationProcedure<{
            input: {
                installationId: string;
                accountLogin: string;
                organizationId?: string | undefined;
                appType?: "standard" | "lite" | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
    }>>;
    gitlab: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        validateInstance: _trpc_server.TRPCMutationProcedure<{
            input: {
                instanceUrl: string;
            };
            output: GitLabInstanceValidationResult;
            meta: object;
        }>;
        validatePAT: _trpc_server.TRPCMutationProcedure<{
            input: {
                token: string;
                instanceUrl?: string | undefined;
            };
            output: GitLabPATValidationResult;
            meta: object;
        }>;
        connectWithPAT: _trpc_server.TRPCMutationProcedure<{
            input: {
                token: string;
                instanceUrl?: string | undefined;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
                integration: {
                    id: string;
                    accountLogin: string;
                    accountId: string;
                    instanceUrl: string;
                };
                warnings?: string[];
            };
            meta: object;
        }>;
        getInstallation: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                installed: boolean;
                installation: null;
            } | {
                installed: boolean;
                installation: {
                    id: string;
                    accountId: string | null;
                    accountLogin: string | null;
                    instanceUrl: string;
                    repositories: PlatformRepository[] | null;
                    repositoriesSyncedAt: string | null;
                    installedAt: string;
                    tokenExpiresAt: string | null;
                    authType: "oauth" | "pat";
                };
            };
            meta: object;
        }>;
        disconnect: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
            } | {
                success: boolean;
                message: string;
            };
            meta: object;
        }>;
        refreshRepositories: _trpc_server.TRPCMutationProcedure<{
            input: {
                integrationId: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
                repositoryCount: number;
                syncedAt: string;
            };
            meta: object;
        }>;
        listRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                integrationId: string;
                organizationId?: string | undefined;
                forceRefresh?: boolean | undefined;
            };
            output: {
                repositories: PlatformRepository[];
                syncedAt: string;
            };
            meta: object;
        }>;
        listBranches: _trpc_server.TRPCQueryProcedure<{
            input: {
                integrationId: string;
                projectPath: string;
                organizationId?: string | undefined;
            };
            output: {
                branches: {
                    name: string;
                    isDefault: boolean;
                }[];
            };
            meta: object;
        }>;
        regenerateWebhookSecret: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            };
            output: {
                webhookSecret: string;
            };
            meta: object;
        }>;
    }>>;
    slack: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        getInstallation: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                installed: boolean;
                installation: null;
            } | {
                installed: boolean;
                installation: {
                    teamId: string | null;
                    teamName: string | null;
                    scopes: string[] | null;
                    installedAt: string;
                    modelSlug: string | null;
                };
            };
            meta: object;
        }>;
        getOAuthUrl: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                url: string;
            };
            meta: object;
        }>;
        uninstallApp: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        testConnection: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
                error?: string;
            };
            meta: object;
        }>;
        sendTestMessage: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
                error?: string;
                channel?: string;
            };
            meta: object;
        }>;
        updateModel: _trpc_server.TRPCMutationProcedure<{
            input: {
                modelSlug: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
                error?: string;
            };
            meta: object;
        }>;
        devRemoveDbRowOnly: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
    }>>;
    discord: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        getInstallation: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                installed: boolean;
                installation: null;
            } | {
                installed: boolean;
                installation: {
                    guildId: string | null;
                    guildName: string | null;
                    scopes: string[] | null;
                    installedAt: string;
                    modelSlug: string | null;
                };
            };
            meta: object;
        }>;
        getOAuthUrl: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                url: string;
            };
            meta: object;
        }>;
        uninstallApp: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        testConnection: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
                error?: string;
            };
            meta: object;
        }>;
        updateModel: _trpc_server.TRPCMutationProcedure<{
            input: {
                modelSlug: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
                error?: string;
            };
            meta: object;
        }>;
        devRemoveDbRowOnly: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId?: string | undefined;
            } | undefined;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
    }>>;
    cloudAgent: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        initiateSessionStream: _trpc_server.TRPCSubscriptionProcedure<{
            input: {
                githubRepo: string;
                prompt: string;
                mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                model: string;
                variant?: string | undefined;
                envVars?: Record<string, string> | undefined;
                setupCommands?: string[] | undefined;
                mcpServers?: Record<string, {
                    command: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    type?: "stdio" | undefined;
                    args?: string[] | undefined;
                    cwd?: string | undefined;
                    env?: Record<string, string> | undefined;
                } | {
                    type: "sse";
                    url: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    headers?: Record<string, string> | undefined;
                } | {
                    type: "streamable-http";
                    url: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    headers?: Record<string, string> | undefined;
                }> | undefined;
                upstreamBranch?: string | undefined;
                autoCommit?: boolean | undefined;
            };
            output: AsyncIterable<StreamEvent, void, any>;
            meta: object;
        }>;
        initiateFromKilocodeSessionStream: _trpc_server.TRPCSubscriptionProcedure<{
            input: {
                kiloSessionId: string;
                githubRepo: string;
                prompt: string;
                mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                model: string;
                envVars?: Record<string, string> | undefined;
                setupCommands?: string[] | undefined;
                autoCommit?: boolean | undefined;
            } | {
                cloudAgentSessionId: string;
            };
            output: AsyncIterable<StreamEvent, void, any>;
            meta: object;
        }>;
        prepareSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                prompt: string;
                mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                model: string;
                githubRepo?: string | undefined;
                gitlabProject?: string | undefined;
                variant?: string | undefined;
                profileName?: string | undefined;
                envVars?: Record<string, string> | undefined;
                setupCommands?: string[] | undefined;
                mcpServers?: Record<string, {
                    command: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    type?: "stdio" | undefined;
                    args?: string[] | undefined;
                    cwd?: string | undefined;
                    env?: Record<string, string> | undefined;
                } | {
                    type: "sse";
                    url: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    headers?: Record<string, string> | undefined;
                } | {
                    type: "streamable-http";
                    url: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    headers?: Record<string, string> | undefined;
                }> | undefined;
                upstreamBranch?: string | undefined;
                autoCommit?: boolean | undefined;
            };
            output: {
                kiloSessionId: string;
                cloudAgentSessionId: string;
            };
            meta: object;
        }>;
        prepareLegacySession: _trpc_server.TRPCMutationProcedure<{
            input: {
                prompt: string;
                mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                model: string;
                cloudAgentSessionId: string;
                kiloSessionId: string;
                githubRepo?: string | undefined;
                gitlabProject?: string | undefined;
                variant?: string | undefined;
                profileName?: string | undefined;
                envVars?: Record<string, string> | undefined;
                setupCommands?: string[] | undefined;
                mcpServers?: Record<string, {
                    command: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    type?: "stdio" | undefined;
                    args?: string[] | undefined;
                    cwd?: string | undefined;
                    env?: Record<string, string> | undefined;
                } | {
                    type: "sse";
                    url: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    headers?: Record<string, string> | undefined;
                } | {
                    type: "streamable-http";
                    url: string;
                    disabled?: boolean | undefined;
                    timeout?: number | undefined;
                    alwaysAllow?: string[] | undefined;
                    watchPaths?: string[] | undefined;
                    disabledTools?: string[] | undefined;
                    headers?: Record<string, string> | undefined;
                }> | undefined;
                upstreamBranch?: string | undefined;
                autoCommit?: boolean | undefined;
            };
            output: {
                kiloSessionId: string;
                cloudAgentSessionId: string;
            };
            meta: object;
        }>;
        sendMessageStream: _trpc_server.TRPCSubscriptionProcedure<{
            input: {
                sessionId: string;
                prompt: string;
                mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                model: string;
                variant?: string | undefined;
                autoCommit?: boolean | undefined;
            };
            output: AsyncIterable<StreamEvent, void, any>;
            meta: object;
        }>;
        listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                forceRefresh?: boolean | undefined;
            } | undefined;
            output: {
                integrationInstalled: boolean;
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                }[];
                syncedAt?: string | null;
                errorMessage?: string;
            };
            meta: object;
        }>;
        listGitLabRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                forceRefresh?: boolean | undefined;
            } | undefined;
            output: {
                integrationInstalled: boolean;
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                }[];
                syncedAt?: string | null;
                errorMessage?: string;
                instanceUrl?: string;
            };
            meta: object;
        }>;
        deleteSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        interruptSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: InterruptResult;
            meta: object;
        }>;
        getSession: _trpc_server.TRPCQueryProcedure<{
            input: {
                cloudAgentSessionId: string;
            };
            output: {
                sessionId: string;
                userId: string;
                timestamp: number;
                version: number;
                kiloSessionId?: string | undefined;
                orgId?: string | undefined;
                sandboxId?: string | undefined;
                githubRepo?: string | undefined;
                gitUrl?: string | undefined;
                prompt?: string | undefined;
                mode?: "code" | "architect" | "ask" | "debug" | "orchestrator" | undefined;
                model?: string | undefined;
                autoCommit?: boolean | undefined;
                condenseOnComplete?: boolean | undefined;
                upstreamBranch?: string | undefined;
                envVarCount?: number | undefined;
                setupCommandCount?: number | undefined;
                mcpServerCount?: number | undefined;
                execution?: {
                    id: string;
                    status: "failed" | "completed" | "interrupted" | "pending" | "running";
                    startedAt?: number | undefined;
                    lastHeartbeat?: number | null | undefined;
                    processId?: string | null | undefined;
                    error?: string | null | undefined;
                    health?: "unknown" | "stale" | "healthy" | undefined;
                } | null | undefined;
                queuedCount?: number | undefined;
                preparedAt?: number | undefined;
                initiatedAt?: number | undefined;
            };
            meta: object;
        }>;
        checkEligibility: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                balance: number;
                minBalance: number;
                isEligible: boolean;
            };
            meta: object;
        }>;
        checkDemoRepositoryFork: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                exists: boolean;
                forkedRepo: string | null;
                githubUsername: string | null;
            };
            meta: object;
        }>;
        initiateFromKilocodeSessionV2: _trpc_server.TRPCMutationProcedure<{
            input: {
                kiloSessionId: string;
                githubRepo: string;
                prompt: string;
                mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                model: string;
                envVars?: Record<string, string> | undefined;
                setupCommands?: string[] | undefined;
                autoCommit?: boolean | undefined;
            } | {
                cloudAgentSessionId: string;
            };
            output: {
                cloudAgentSessionId: string;
                executionId: string;
                status: "queued" | "started";
                streamUrl: string;
            };
            meta: object;
        }>;
        sendMessageV2: _trpc_server.TRPCMutationProcedure<{
            input: {
                cloudAgentSessionId: string;
                prompt: string;
                mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                model: string;
                variant?: string | undefined;
                autoCommit?: boolean | undefined;
            };
            output: {
                cloudAgentSessionId: string;
                executionId: string;
                status: "queued" | "started";
                streamUrl: string;
            };
            meta: object;
        }>;
    }>>;
    cloudAgentNext: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        prepareSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                prompt: string;
                mode: "custom" | "plan" | "code" | "architect" | "ask" | "debug" | "orchestrator" | "build";
                model: string;
                githubRepo?: string | undefined;
                gitlabProject?: string | undefined;
                variant?: string | undefined;
                profileName?: string | undefined;
                envVars?: Record<string, string> | undefined;
                setupCommands?: string[] | undefined;
                mcpServers?: Record<string, {
                    type: "local";
                    command: string[];
                    environment?: Record<string, string> | undefined;
                    enabled?: boolean | undefined;
                    timeout?: number | undefined;
                } | {
                    type: "remote";
                    url: string;
                    headers?: Record<string, string> | undefined;
                    enabled?: boolean | undefined;
                    timeout?: number | undefined;
                }> | undefined;
                upstreamBranch?: string | undefined;
                autoCommit?: boolean | undefined;
                autoInitiate?: boolean | undefined;
            };
            output: {
                kiloSessionId: string;
                cloudAgentSessionId: string;
            };
            meta: object;
        }>;
        initiateFromPreparedSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                cloudAgentSessionId: string;
            };
            output: {
                cloudAgentSessionId: string;
                executionId: string;
                status: "started";
                streamUrl: string;
            };
            meta: object;
        }>;
        sendMessage: _trpc_server.TRPCMutationProcedure<{
            input: {
                cloudAgentSessionId: string;
                prompt: string;
                mode: "plan" | "code" | "ask" | "debug" | "orchestrator";
                model: string;
                variant?: string | undefined;
                autoCommit?: boolean | undefined;
            };
            output: {
                cloudAgentSessionId: string;
                executionId: string;
                status: "started";
                streamUrl: string;
            };
            meta: object;
        }>;
        interruptSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: {
                success: boolean;
                message: string;
                processesFound: boolean;
            };
            meta: object;
        }>;
        answerQuestion: _trpc_server.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                questionId: string;
                answers: string[][];
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        rejectQuestion: _trpc_server.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                questionId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        getSession: _trpc_server.TRPCQueryProcedure<{
            input: {
                cloudAgentSessionId: string;
            };
            output: {
                sessionId: string;
                userId: string;
                execution: {
                    id: string;
                    status: "failed" | "completed" | "interrupted" | "pending" | "running";
                    startedAt: number;
                    lastHeartbeat: number | null;
                    processId: string | null;
                    error: string | null;
                    health: "unknown" | "stale" | "healthy";
                } | null;
                timestamp: number;
                version: number;
                kiloSessionId?: string | undefined;
                orgId?: string | undefined;
                sandboxId?: string | undefined;
                githubRepo?: string | undefined;
                gitUrl?: string | undefined;
                platform?: "github" | "gitlab" | undefined;
                prompt?: string | undefined;
                mode?: "custom" | "plan" | "code" | "architect" | "ask" | "debug" | "orchestrator" | "build" | undefined;
                model?: string | undefined;
                autoCommit?: boolean | undefined;
                upstreamBranch?: string | undefined;
                envVarCount?: number | undefined;
                setupCommandCount?: number | undefined;
                mcpServerCount?: number | undefined;
                preparedAt?: number | undefined;
                initiatedAt?: number | undefined;
                callbackTarget?: {
                    url: string;
                    headers?: Record<string, string> | undefined;
                } | undefined;
            };
            meta: object;
        }>;
        listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                forceRefresh?: boolean | undefined;
            };
            output: {
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                    defaultBranch?: string | undefined;
                }[];
                integrationInstalled: boolean;
                syncedAt?: string | null | undefined;
                errorMessage?: string | undefined;
            };
            meta: object;
        }>;
        listGitLabRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                forceRefresh?: boolean | undefined;
            };
            output: {
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                }[];
                integrationInstalled: boolean;
                syncedAt?: string | null | undefined;
                errorMessage?: string | undefined;
            };
            meta: object;
        }>;
    }>>;
    codeReviews: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        listForOrganization: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
                status?: "failed" | "completed" | "queued" | "cancelled" | "interrupted" | "pending" | "running" | undefined;
                platform?: "github" | "gitlab" | undefined;
                offset?: number | undefined;
                limit?: number | undefined;
                repoFullName?: string | undefined;
            };
            output: FailureResult<string> | SuccessResult<ListCodeReviewsResponse>;
            meta: object;
        }>;
        listForUser: _trpc_server.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                offset?: number | undefined;
                status?: "failed" | "completed" | "queued" | "cancelled" | "interrupted" | "pending" | "running" | undefined;
                repoFullName?: string | undefined;
                platform?: "github" | "gitlab" | undefined;
            };
            output: FailureResult<string> | SuccessResult<ListCodeReviewsResponse>;
            meta: object;
        }>;
        get: _trpc_server.TRPCQueryProcedure<{
            input: {
                reviewId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                review: {
                    id: string;
                    updated_at: string;
                    created_at: string;
                    model: string | null;
                    status: string;
                    started_at: string | null;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    session_id: string | null;
                    platform: string;
                    platform_integration_id: string | null;
                    completed_at: string | null;
                    repo_full_name: string;
                    pr_number: number;
                    pr_url: string;
                    pr_title: string;
                    pr_author: string;
                    pr_author_github_id: string | null;
                    base_ref: string;
                    head_ref: string;
                    head_sha: string;
                    platform_project_id: number | null;
                    cli_session_id: string | null;
                    error_message: string | null;
                    terminal_reason: string | null;
                    agent_version: string | null;
                    check_run_id: number | null;
                    total_tokens_in: number | null;
                    total_tokens_out: number | null;
                    total_cost_musd: number | null;
                };
            }>;
            meta: object;
        }>;
        cancel: _trpc_server.TRPCMutationProcedure<{
            input: {
                reviewId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
        retrigger: _trpc_server.TRPCMutationProcedure<{
            input: {
                reviewId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
        getReviewEvents: _trpc_server.TRPCQueryProcedure<{
            input: {
                reviewId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                events: ReviewEvent[];
            }>;
            meta: object;
        }>;
        getReviewStreamInfo: _trpc_server.TRPCQueryProcedure<{
            input: {
                reviewId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                cloudAgentSessionId: string | null;
                organizationId: string | undefined;
                status: string;
                agentVersion: string;
            }>;
            meta: object;
        }>;
        getSessionMessages: _trpc_server.TRPCQueryProcedure<{
            input: {
                reviewId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                entries: SessionLogEntry[];
            }>;
            meta: object;
        }>;
    }>>;
    personalReviewAgent: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        getGitHubStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                connected: boolean;
                integration: null;
            } | {
                connected: boolean;
                integration: {
                    accountLogin: string | null;
                    repositorySelection: string | null;
                    installedAt: string;
                    isValid: boolean;
                };
            };
            meta: object;
        }>;
        listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                forceRefresh?: boolean | undefined;
            } | undefined;
            output: {
                integrationInstalled: boolean;
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                }[];
                syncedAt?: string | null;
                errorMessage?: string;
            };
            meta: object;
        }>;
        getGitLabStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                connected: boolean;
                integration: null;
            } | {
                connected: boolean;
                integration: {
                    accountLogin: string | null;
                    repositorySelection: string | null;
                    installedAt: string;
                    isValid: boolean;
                    webhookSecret: string | undefined;
                    instanceUrl: string;
                };
            };
            meta: object;
        }>;
        listGitLabRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                forceRefresh?: boolean | undefined;
            } | undefined;
            output: {
                integrationInstalled: boolean;
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                }[];
                syncedAt?: string | null;
                errorMessage?: string;
                instanceUrl?: string;
            };
            meta: object;
        }>;
        searchGitLabRepositories: _trpc_server.TRPCQueryProcedure<{
            input: {
                query: string;
            };
            output: {
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                }[];
                errorMessage?: string;
            };
            meta: object;
        }>;
        getReviewConfig: _trpc_server.TRPCQueryProcedure<{
            input: {
                platform?: "github" | "gitlab" | undefined;
            } | undefined;
            output: {
                isEnabled: boolean;
                reviewStyle: "strict" | "balanced" | "lenient" | "roast";
                focusAreas: string[];
                customInstructions: string | null;
                maxReviewTimeMinutes: number;
                modelSlug: string;
                thinkingEffort: string | null;
                gateThreshold: "all" | "off" | "warning" | "critical";
                repositorySelectionMode: "all" | "selected";
                selectedRepositoryIds: number[];
                manuallyAddedRepositories: {
                    id: number;
                    name: string;
                    full_name: string;
                    private: boolean;
                }[];
                isCloudAgentNextEnabled: boolean;
                isPrGateEnabled: boolean;
            };
            meta: object;
        }>;
        saveReviewConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                reviewStyle: "strict" | "balanced" | "lenient" | "roast";
                focusAreas: string[];
                maxReviewTimeMinutes: number;
                modelSlug: string;
                platform?: "github" | "gitlab" | undefined;
                customInstructions?: string | undefined;
                thinkingEffort?: string | null | undefined;
                repositorySelectionMode?: "all" | "selected" | undefined;
                selectedRepositoryIds?: number[] | undefined;
                manuallyAddedRepositories?: {
                    id: number;
                    name: string;
                    full_name: string;
                    private: boolean;
                }[] | undefined;
                gateThreshold?: "all" | "off" | "warning" | "critical" | undefined;
                autoConfigureWebhooks?: boolean | undefined;
            };
            output: {
                success: boolean;
                webhookSync: {
                    created: number;
                    updated: number;
                    deleted: number;
                    errors: {
                        projectId: number;
                        error: string;
                        operation: "create" | "update" | "delete";
                    }[];
                } | {
                    created: number;
                    updated: number;
                    deleted: number;
                    errors: {
                        projectId: number;
                        error: string;
                        operation: "sync";
                    }[];
                } | null;
            };
            meta: object;
        }>;
        toggleReviewAgent: _trpc_server.TRPCMutationProcedure<{
            input: {
                isEnabled: boolean;
                platform?: "github" | "gitlab" | undefined;
            };
            output: {
                success: boolean;
                isEnabled: boolean;
            };
            meta: object;
        }>;
    }>>;
    byok: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        listSupportedModels: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: Record<string, string[]>;
            meta: object;
        }>;
        list: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            };
            output: {
                id: string;
                provider_id: string;
                provider_name: string;
                is_enabled: boolean;
                created_at: string;
                updated_at: string;
                created_by: string;
            }[];
            meta: object;
        }>;
        create: _trpc_server.TRPCMutationProcedure<{
            input: {
                provider_id: string;
                api_key: string;
                organizationId?: string | undefined;
            };
            output: {
                id: string;
                provider_id: string;
                provider_name: string;
                is_enabled: boolean;
                created_at: string;
                updated_at: string;
                created_by: string;
            };
            meta: object;
        }>;
        update: _trpc_server.TRPCMutationProcedure<{
            input: {
                id: string;
                api_key: string;
                organizationId?: string | undefined;
            };
            output: {
                id: string;
                provider_id: string;
                provider_name: string;
                is_enabled: boolean;
                created_at: string;
                updated_at: string;
                created_by: string;
            };
            meta: object;
        }>;
        setEnabled: _trpc_server.TRPCMutationProcedure<{
            input: {
                id: string;
                is_enabled: boolean;
                organizationId?: string | undefined;
            };
            output: {
                id: string;
                provider_id: string;
                provider_name: string;
                is_enabled: boolean;
                created_at: string;
                updated_at: string;
                created_by: string;
            };
            meta: object;
        }>;
        testApiKey: _trpc_server.TRPCMutationProcedure<{
            input: {
                id: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
                message: string;
            };
            meta: object;
        }>;
        delete: _trpc_server.TRPCMutationProcedure<{
            input: {
                id: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
    }>>;
    appBuilder: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        createProject: _trpc_server.TRPCMutationProcedure<{
            input: {
                prompt: string;
                model: string;
                title?: string | undefined;
                images?: {
                    path: string;
                    files: string[];
                } | undefined;
                template?: "resume" | "startup-landing-page" | undefined;
                mode?: "code" | "ask" | undefined;
            };
            output: CreateProjectResult;
            meta: object;
        }>;
        getPreviewUrl: _trpc_server.TRPCQueryProcedure<{
            input: {
                projectId: string;
            };
            output: {
                status: string;
                previewUrl: string | null;
            };
            meta: object;
        }>;
        triggerBuild: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
            };
            output: {
                success: true;
            };
            meta: object;
        }>;
        getProject: _trpc_server.TRPCQueryProcedure<{
            input: {
                projectId: string;
            };
            output: ProjectWithMessages;
            meta: object;
        }>;
        listProjects: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                id: string;
                updated_at: string;
                created_at: string;
                owned_by_user_id: string | null;
                owned_by_organization_id: string | null;
                created_by_user_id: string | null;
                session_id: string | null;
                deployment_id: string | null;
                title: string;
                model_id: string;
                template: string | null;
                last_message_at: string | null;
                git_repo_full_name: string | null;
                git_platform_integration_id: string | null;
                migrated_at: string | null;
            }[];
            meta: object;
        }>;
        deployProject: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
            };
            output: DeployProjectResult;
            meta: object;
        }>;
        checkEligibility: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                balance: number;
                minBalance: number;
                accessLevel: "full" | "limited";
                isEligible: boolean;
            };
            meta: object;
        }>;
        generateCloneToken: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
            };
            output: {
                token: string;
                gitUrl: string;
                expiresAt: string;
            };
            meta: object;
        }>;
        deleteProject: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        interruptSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        getImageUploadUrl: _trpc_server.TRPCMutationProcedure<{
            input: {
                messageUuid: string;
                imageId: string;
                contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                contentLength: number;
            };
            output: GenerateImageUploadUrlResult;
            meta: object;
        }>;
        startSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
            };
            output: {
                cloudAgentSessionId: string;
            };
            meta: object;
        }>;
        sendMessage: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
                message: string;
                images?: {
                    path: string;
                    files: string[];
                } | undefined;
                model?: string | undefined;
            };
            output: {
                cloudAgentSessionId: string;
                workerVersion: WorkerVersion;
            };
            meta: object;
        }>;
        prepareLegacySession: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
                model: string;
                prompt: string;
            };
            output: {
                cloudAgentSessionId: string;
            };
            meta: object;
        }>;
        canMigrateToGitHub: _trpc_server.TRPCQueryProcedure<{
            input: {
                projectId: string;
            };
            output: CanMigrateToGitHubResult;
            meta: object;
        }>;
        migrateToGitHub: _trpc_server.TRPCMutationProcedure<{
            input: {
                projectId: string;
                repoFullName: string;
            };
            output: MigrateToGitHubResult;
            meta: object;
        }>;
    }>>;
    securityAgent: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        getPermissionStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                hasIntegration: boolean;
                hasPermissions: boolean;
                reauthorizeUrl: string | null;
            };
            meta: object;
        }>;
        getConfig: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                isEnabled: boolean;
                slaCriticalDays: number;
                slaHighDays: number;
                slaMediumDays: number;
                slaLowDays: number;
                autoSyncEnabled: boolean;
                repositorySelectionMode: "all" | "selected";
                selectedRepositoryIds: number[];
                modelSlug: string;
                triageModelSlug: string;
                analysisModelSlug: string;
                analysisMode: "auto" | "deep" | "shallow";
                autoDismissEnabled: boolean;
                autoDismissConfidenceThreshold: "high" | "medium" | "low";
                autoAnalysisEnabled: boolean;
                autoAnalysisMinSeverity: "all" | "critical" | "high" | "medium";
                autoAnalysisIncludeExisting: boolean;
            };
            meta: object;
        }>;
        saveConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                slaCriticalDays?: number | undefined;
                slaHighDays?: number | undefined;
                slaMediumDays?: number | undefined;
                slaLowDays?: number | undefined;
                autoSyncEnabled?: boolean | undefined;
                repositorySelectionMode?: "all" | "selected" | undefined;
                selectedRepositoryIds?: number[] | undefined;
                modelSlug?: string | undefined;
                triageModelSlug?: string | undefined;
                analysisModelSlug?: string | undefined;
                analysisMode?: "auto" | "deep" | "shallow" | undefined;
                autoDismissEnabled?: boolean | undefined;
                autoDismissConfidenceThreshold?: "high" | "medium" | "low" | undefined;
                autoAnalysisEnabled?: boolean | undefined;
                autoAnalysisMinSeverity?: "all" | "critical" | "high" | "medium" | undefined;
                autoAnalysisIncludeExisting?: boolean | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        setEnabled: _trpc_server.TRPCMutationProcedure<{
            input: {
                isEnabled: boolean;
                repositorySelectionMode?: "all" | "selected" | undefined;
                selectedRepositoryIds?: number[] | undefined;
            };
            output: {
                success: boolean;
                syncResult: {
                    synced: number;
                    errors: number;
                };
            } | {
                success: boolean;
                syncResult?: undefined;
            };
            meta: object;
        }>;
        getRepositories: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                id: number;
                fullName: string;
                name: string;
                private: boolean;
            }[];
            meta: object;
        }>;
        listFindings: _trpc_server.TRPCQueryProcedure<{
            input: {
                repoFullName?: string | undefined;
                status?: "open" | "fixed" | "closed" | "ignored" | undefined;
                severity?: "critical" | "high" | "medium" | "low" | undefined;
                outcomeFilter?: "failed" | "all" | "fixed" | "dismissed" | "analyzing" | "not_analyzed" | "exploitable" | "not_exploitable" | "safe_to_dismiss" | "needs_review" | "triage_complete" | undefined;
                overdue?: boolean | undefined;
                sortBy?: "severity_desc" | "severity_asc" | "sla_due_at_asc" | undefined;
                limit?: number | undefined;
                offset?: number | undefined;
            };
            output: {
                findings: {
                    description: string | null;
                    id: string;
                    updated_at: string;
                    created_at: string;
                    status: string;
                    source: string;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    session_id: string | null;
                    platform_integration_id: string | null;
                    repo_full_name: string;
                    cli_session_id: string | null;
                    title: string;
                    source_id: string;
                    severity: string;
                    ghsa_id: string | null;
                    cve_id: string | null;
                    package_name: string;
                    package_ecosystem: string;
                    vulnerable_version_range: string | null;
                    patched_version: string | null;
                    manifest_path: string | null;
                    ignored_reason: string | null;
                    ignored_by: string | null;
                    fixed_at: string | null;
                    sla_due_at: string | null;
                    dependabot_html_url: string | null;
                    cwe_ids: string[] | null;
                    cvss_score: string | null;
                    dependency_scope: string | null;
                    analysis_status: string | null;
                    analysis_started_at: string | null;
                    analysis_completed_at: string | null;
                    analysis_error: string | null;
                    analysis: SecurityFindingAnalysis | null;
                    raw_data: DependabotAlertRaw | null;
                    first_detected_at: string;
                    last_synced_at: string;
                }[];
                totalCount: number;
                runningCount: number;
                concurrencyLimit: number;
            };
            meta: object;
        }>;
        getFinding: _trpc_server.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: {
                description: string | null;
                id: string;
                updated_at: string;
                created_at: string;
                status: string;
                source: string;
                owned_by_user_id: string | null;
                owned_by_organization_id: string | null;
                session_id: string | null;
                platform_integration_id: string | null;
                repo_full_name: string;
                cli_session_id: string | null;
                title: string;
                source_id: string;
                severity: string;
                ghsa_id: string | null;
                cve_id: string | null;
                package_name: string;
                package_ecosystem: string;
                vulnerable_version_range: string | null;
                patched_version: string | null;
                manifest_path: string | null;
                ignored_reason: string | null;
                ignored_by: string | null;
                fixed_at: string | null;
                sla_due_at: string | null;
                dependabot_html_url: string | null;
                cwe_ids: string[] | null;
                cvss_score: string | null;
                dependency_scope: string | null;
                analysis_status: string | null;
                analysis_started_at: string | null;
                analysis_completed_at: string | null;
                analysis_error: string | null;
                analysis: SecurityFindingAnalysis | null;
                raw_data: DependabotAlertRaw | null;
                first_detected_at: string;
                last_synced_at: string;
            };
            meta: object;
        }>;
        getStats: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                total: number;
                critical: number;
                high: number;
                medium: number;
                low: number;
                open: number;
                fixed: number;
                ignored: number;
            };
            meta: object;
        }>;
        getDashboardStats: _trpc_server.TRPCQueryProcedure<{
            input: {
                repoFullName?: string | undefined;
            };
            output: DashboardStats;
            meta: object;
        }>;
        getLastSyncTime: _trpc_server.TRPCQueryProcedure<{
            input: {
                repoFullName?: string | undefined;
            };
            output: {
                lastSyncTime: string | null;
            };
            meta: object;
        }>;
        triggerSync: _trpc_server.TRPCMutationProcedure<{
            input: {
                repoFullName?: string | undefined;
            };
            output: {
                success: boolean;
                synced: number;
                errors: number;
            };
            meta: object;
        }>;
        dismissFinding: _trpc_server.TRPCMutationProcedure<{
            input: {
                findingId: string;
                reason: "fix_started" | "inaccurate" | "no_bandwidth" | "not_used" | "tolerable_risk";
                comment?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        startAnalysis: _trpc_server.TRPCMutationProcedure<{
            input: {
                findingId: string;
                model?: string | undefined;
                triageModel?: string | undefined;
                analysisModel?: string | undefined;
                retrySandboxOnly?: boolean | undefined;
            };
            output: {
                success: boolean;
                triageOnly: boolean | undefined;
            };
            meta: object;
        }>;
        getAnalysis: _trpc_server.TRPCQueryProcedure<{
            input: {
                findingId: string;
            };
            output: {
                status: string | null;
                startedAt: string | null;
                completedAt: string | null;
                error: string | null;
                analysis: SecurityFindingAnalysis | null;
                sessionId: string | null;
                cliSessionId: string | null;
            };
            meta: object;
        }>;
        getOrphanedRepositories: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                repoFullName: string;
                findingCount: number;
            }[];
            meta: object;
        }>;
        deleteFindingsByRepository: _trpc_server.TRPCMutationProcedure<{
            input: {
                repoFullName: string;
            };
            output: {
                success: boolean;
                deletedCount: number;
            };
            meta: object;
        }>;
        getAutoDismissEligible: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                eligible: number;
                byConfidence: {
                    high: number;
                    medium: number;
                    low: number;
                };
            };
            meta: object;
        }>;
        autoDismissEligible: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                dismissed: number;
                skipped: number;
                errors: number;
            };
            meta: object;
        }>;
    }>>;
    securityAuditLog: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        list: _trpc_server.TRPCQueryProcedure<{
            input: {
                before?: string | undefined;
                after?: string | undefined;
                action?: SecurityAuditLogAction[] | undefined;
                actorEmail?: string | undefined;
                resourceType?: string | undefined;
                resourceId?: string | undefined;
                fuzzySearch?: string | undefined;
                startTime?: string | undefined;
                endTime?: string | undefined;
            };
            output: {
                logs: {
                    id: string;
                    action: SecurityAuditLogAction;
                    actor_id: string | null;
                    actor_email: string | null;
                    actor_name: string | null;
                    resource_type: string;
                    resource_id: string;
                    before_state: Record<string, unknown> | null;
                    after_state: Record<string, unknown> | null;
                    metadata: Record<string, unknown> | null;
                    created_at: string;
                }[];
                hasNext: boolean;
                hasPrevious: boolean;
                oldestTimestamp: string | null;
                newestTimestamp: string | null;
            };
            meta: object;
        }>;
        getActionTypes: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: SecurityAuditLogAction[];
            meta: object;
        }>;
        getSummary: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                totalEvents: number;
                earliestEvent: string | null;
                latestEvent: string | null;
            };
            meta: object;
        }>;
        export: _trpc_server.TRPCMutationProcedure<{
            input: {
                format?: "json" | "csv" | undefined;
                startTime?: string | undefined;
                endTime?: string | undefined;
                action?: SecurityAuditLogAction[] | undefined;
            };
            output: {
                format: "csv";
                data: string;
                rowCount: number;
            } | {
                format: "json";
                data: string;
                rowCount: number;
            };
            meta: object;
        }>;
    }>>;
    autoTriage: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        listTicketsForOrganization: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
                status?: "failed" | "pending" | "analyzing" | "actioned" | "skipped" | undefined;
                classification?: "feature" | "bug" | "question" | "duplicate" | "unclear" | undefined;
                offset?: number | undefined;
                limit?: number | undefined;
                repoFullName?: string | undefined;
            };
            output: FailureResult<string> | SuccessResult<ListTriageTicketsResponse>;
            meta: object;
        }>;
        listTicketsForUser: _trpc_server.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                offset?: number | undefined;
                status?: "failed" | "pending" | "analyzing" | "actioned" | "skipped" | undefined;
                classification?: "feature" | "bug" | "question" | "duplicate" | "unclear" | undefined;
                repoFullName?: string | undefined;
            };
            output: FailureResult<string> | SuccessResult<ListTriageTicketsResponse>;
            meta: object;
        }>;
        getTicket: _trpc_server.TRPCQueryProcedure<{
            input: {
                ticketId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                ticket: {
                    id: string;
                    updated_at: string;
                    created_at: string;
                    status: "failed" | "pending" | "analyzing" | "actioned" | "skipped";
                    started_at: string | null;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    session_id: string | null;
                    platform: string;
                    platform_integration_id: string | null;
                    completed_at: string | null;
                    repo_full_name: string;
                    error_message: string | null;
                    issue_number: number;
                    issue_url: string;
                    issue_title: string;
                    issue_body: string | null;
                    issue_author: string;
                    issue_type: "issue" | "pull_request";
                    issue_labels: string[] | null;
                    classification: "feature" | "bug" | "question" | "duplicate" | "unclear" | null;
                    confidence: string | null;
                    intent_summary: string | null;
                    related_files: string[] | null;
                    is_duplicate: boolean | null;
                    duplicate_of_ticket_id: string | null;
                    similarity_score: string | null;
                    qdrant_point_id: string | null;
                    should_auto_fix: boolean | null;
                    action_taken: "pr_created" | "comment_posted" | "closed_duplicate" | "needs_clarification" | null;
                    action_metadata: unknown;
                };
            }>;
            meta: object;
        }>;
        retrigger: _trpc_server.TRPCMutationProcedure<{
            input: {
                ticketId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
        getConfig: _trpc_server.TRPCQueryProcedure<{
            input: {
                [x: string]: never;
                organizationId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                config: {
                    isEnabled: boolean;
                    enabled_for_issues: boolean;
                    repository_selection_mode: "all";
                    selected_repository_ids: number[];
                    skip_labels: string[];
                    required_labels: string[];
                    duplicate_threshold: 0.8;
                    auto_fix_threshold: 0.8;
                    auto_create_pr_threshold: 0.8;
                    max_concurrent_per_owner: 10;
                    custom_instructions: null;
                    model_slug: string;
                    max_classification_time_minutes: number;
                    max_pr_creation_time_minutes: number;
                };
                isEnabled: boolean;
            }> | SuccessResult<{
                config: Record<string, unknown> | {
                    review_style: "strict" | "balanced" | "lenient" | "roast";
                    focus_areas: string[];
                    max_review_time_minutes: number;
                    model_slug: string;
                    auto_approve_minor?: boolean | undefined;
                    custom_instructions?: string | null | undefined;
                    thinking_effort?: string | null | undefined;
                    repository_selection_mode?: "all" | "selected" | undefined;
                    selected_repository_ids?: number[] | undefined;
                    manually_added_repositories?: {
                        id: number;
                        name: string;
                        full_name: string;
                        private: boolean;
                    }[] | undefined;
                    gate_threshold?: "all" | "off" | "warning" | "critical" | undefined;
                };
                isEnabled: boolean;
            }>;
            meta: object;
        }>;
        saveConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId: string;
                repository_selection_mode: "all" | "selected";
                enabled_for_issues: boolean;
                custom_instructions?: string | null | undefined;
                model_slug?: string | undefined;
                selected_repository_ids?: number[] | undefined;
                skip_labels?: string[] | undefined;
                required_labels?: string[] | undefined;
                duplicate_threshold?: number | undefined;
                auto_fix_threshold?: number | undefined;
                max_concurrent_per_owner?: number | undefined;
                max_classification_time_minutes?: number | undefined;
                auto_create_pr_threshold?: number | undefined;
                pr_branch_prefix?: string | undefined;
                pr_title_template?: string | undefined;
                pr_body_template?: string | undefined;
                pr_base_branch?: string | undefined;
                max_pr_creation_time_minutes?: number | undefined;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
    }>>;
    personalAutoTriage: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        getGitHubStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                connected: boolean;
                integration: null;
            } | {
                connected: boolean;
                integration: {
                    accountLogin: string | null;
                    repositorySelection: string | null;
                    installedAt: string | Date | null;
                    isValid: boolean;
                };
            };
            meta: object;
        }>;
        listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                integrationInstalled: boolean;
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                }[];
                errorMessage?: string;
            };
            meta: object;
        }>;
        getAutoTriageConfig: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                isEnabled: boolean;
                enabled_for_issues: boolean;
                repository_selection_mode: "all" | "selected";
                selected_repository_ids: number[];
                skip_labels: string[];
                required_labels: string[];
                duplicate_threshold: number;
                auto_fix_threshold: number;
                auto_create_pr_threshold: number;
                max_concurrent_per_owner: number;
                custom_instructions: string | null;
                model_slug: string;
                max_classification_time_minutes: number;
                max_pr_creation_time_minutes: number;
            };
            meta: object;
        }>;
        saveAutoTriageConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                enabled_for_issues: boolean;
                repository_selection_mode: "all" | "selected";
                selected_repository_ids?: number[] | undefined;
                skip_labels?: string[] | undefined;
                required_labels?: string[] | undefined;
                duplicate_threshold?: number | undefined;
                auto_fix_threshold?: number | undefined;
                auto_create_pr_threshold?: number | undefined;
                max_concurrent_per_owner?: number | undefined;
                custom_instructions?: string | null | undefined;
                model_slug?: string | undefined;
                pr_branch_prefix?: string | undefined;
                pr_title_template?: string | undefined;
                pr_body_template?: string | undefined;
                pr_base_branch?: string | undefined;
                max_classification_time_minutes?: number | undefined;
                max_pr_creation_time_minutes?: number | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        toggleAutoTriageAgent: _trpc_server.TRPCMutationProcedure<{
            input: {
                isEnabled: boolean;
            };
            output: {
                success: boolean;
                isEnabled: boolean;
            };
            meta: object;
        }>;
        retryTicket: _trpc_server.TRPCMutationProcedure<{
            input: {
                ticketId: string;
            };
            output: SuccessResult<{
                ticketId: string;
            }>;
            meta: object;
        }>;
        interruptTicket: _trpc_server.TRPCMutationProcedure<{
            input: {
                ticketId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        listTickets: _trpc_server.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                offset?: number | undefined;
                status?: "failed" | "pending" | "analyzing" | "actioned" | "skipped" | undefined;
                classification?: "feature" | "bug" | "question" | "duplicate" | "unclear" | undefined;
                repoFullName?: string | undefined;
            };
            output: FailureResult<string> | SuccessResult<{
                tickets: {
                    id: string;
                    updated_at: string;
                    created_at: string;
                    status: "failed" | "pending" | "analyzing" | "actioned" | "skipped";
                    started_at: string | null;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    session_id: string | null;
                    platform: string;
                    platform_integration_id: string | null;
                    completed_at: string | null;
                    repo_full_name: string;
                    error_message: string | null;
                    issue_number: number;
                    issue_url: string;
                    issue_title: string;
                    issue_body: string | null;
                    issue_author: string;
                    issue_type: "issue" | "pull_request";
                    issue_labels: string[] | null;
                    classification: "feature" | "bug" | "question" | "duplicate" | "unclear" | null;
                    confidence: string | null;
                    intent_summary: string | null;
                    related_files: string[] | null;
                    is_duplicate: boolean | null;
                    duplicate_of_ticket_id: string | null;
                    similarity_score: string | null;
                    qdrant_point_id: string | null;
                    should_auto_fix: boolean | null;
                    action_taken: "pr_created" | "comment_posted" | "closed_duplicate" | "needs_clarification" | null;
                    action_metadata: unknown;
                }[];
                total: number;
                hasMore: boolean;
            }>;
            meta: object;
        }>;
    }>>;
    autoFix: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        listTicketsForOrganization: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
                status?: "failed" | "completed" | "cancelled" | "pending" | "running" | undefined;
                classification?: "feature" | "bug" | "question" | "unclear" | undefined;
                offset?: number | undefined;
                limit?: number | undefined;
                repoFullName?: string | undefined;
            };
            output: FailureResult<string> | SuccessResult<ListFixTicketsResponse>;
            meta: object;
        }>;
        listTicketsForUser: _trpc_server.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                offset?: number | undefined;
                status?: "failed" | "completed" | "cancelled" | "pending" | "running" | undefined;
                classification?: "feature" | "bug" | "question" | "unclear" | undefined;
                repoFullName?: string | undefined;
            };
            output: FailureResult<string> | SuccessResult<ListFixTicketsResponse>;
            meta: object;
        }>;
        getTicket: _trpc_server.TRPCQueryProcedure<{
            input: {
                ticketId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                ticket: {
                    id: string;
                    updated_at: string;
                    created_at: string;
                    status: "failed" | "completed" | "cancelled" | "pending" | "running";
                    started_at: string | null;
                    owned_by_user_id: string | null;
                    owned_by_organization_id: string | null;
                    session_id: string | null;
                    file_path: string | null;
                    platform: string;
                    platform_integration_id: string | null;
                    completed_at: string | null;
                    repo_full_name: string;
                    pr_number: number | null;
                    pr_url: string | null;
                    cli_session_id: string | null;
                    error_message: string | null;
                    issue_number: number;
                    issue_url: string;
                    issue_title: string;
                    issue_body: string | null;
                    issue_author: string;
                    issue_labels: string[] | null;
                    classification: "feature" | "bug" | "question" | "unclear" | null;
                    confidence: string | null;
                    intent_summary: string | null;
                    related_files: string[] | null;
                    triage_ticket_id: string | null;
                    trigger_source: "label" | "review_comment";
                    review_comment_id: number | null;
                    review_comment_body: string | null;
                    line_number: number | null;
                    diff_hunk: string | null;
                    pr_head_ref: string | null;
                    pr_branch: string | null;
                };
            }>;
            meta: object;
        }>;
        retrigger: _trpc_server.TRPCMutationProcedure<{
            input: {
                ticketId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
        cancel: _trpc_server.TRPCMutationProcedure<{
            input: {
                ticketId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
        getConfig: _trpc_server.TRPCQueryProcedure<{
            input: {
                [x: string]: never;
                organizationId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                config: {
                    enabled_for_issues: boolean;
                    enabled_for_review_comments: boolean;
                    repository_selection_mode: "all" | "selected";
                    selected_repository_ids: number[];
                    skip_labels: string[];
                    required_labels: string[];
                    model_slug: string;
                    pr_title_template: string;
                    pr_base_branch: string;
                    max_pr_creation_time_minutes: number;
                    max_concurrent_per_owner: number;
                    custom_instructions?: string | null | undefined;
                    pr_body_template?: string | null | undefined;
                };
                isEnabled: boolean;
            }> | SuccessResult<{
                config: Record<string, unknown> | {
                    review_style: "strict" | "balanced" | "lenient" | "roast";
                    focus_areas: string[];
                    max_review_time_minutes: number;
                    model_slug: string;
                    auto_approve_minor?: boolean | undefined;
                    custom_instructions?: string | null | undefined;
                    thinking_effort?: string | null | undefined;
                    repository_selection_mode?: "all" | "selected" | undefined;
                    selected_repository_ids?: number[] | undefined;
                    manually_added_repositories?: {
                        id: number;
                        name: string;
                        full_name: string;
                        private: boolean;
                    }[] | undefined;
                    gate_threshold?: "all" | "off" | "warning" | "critical" | undefined;
                };
                isEnabled: boolean;
            }>;
            meta: object;
        }>;
        saveConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId: string;
                repository_selection_mode: "all" | "selected";
                enabled_for_issues: boolean;
                custom_instructions?: string | null | undefined;
                model_slug?: string | undefined;
                selected_repository_ids?: number[] | undefined;
                skip_labels?: string[] | undefined;
                required_labels?: string[] | undefined;
                max_concurrent_per_owner?: number | undefined;
                pr_title_template?: string | undefined;
                pr_body_template?: string | null | undefined;
                pr_base_branch?: string | undefined;
                max_pr_creation_time_minutes?: number | undefined;
                enabled_for_review_comments?: boolean | undefined;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
        toggleAgent: _trpc_server.TRPCMutationProcedure<{
            input: {
                organizationId: string;
                isEnabled: boolean;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
                isEnabled: boolean;
            }>;
            meta: object;
        }>;
    }>>;
    personalAutoFix: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        listGitHubRepositories: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                integrationInstalled: boolean;
                repositories: {
                    id: number;
                    name: string;
                    fullName: string;
                    private: boolean;
                }[];
                syncedAt?: string | null;
                errorMessage?: string;
            };
            meta: object;
        }>;
        getAutoFixConfig: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                enabled_for_issues: boolean;
                enabled_for_review_comments: boolean;
                repository_selection_mode: "all" | "selected";
                selected_repository_ids: number[];
                skip_labels: string[];
                required_labels: string[];
                model_slug: string;
                pr_title_template: string;
                pr_base_branch: string;
                max_pr_creation_time_minutes: number;
                max_concurrent_per_owner: number;
                custom_instructions?: string | null | undefined;
                pr_body_template?: string | null | undefined;
                isEnabled: boolean;
            };
            meta: object;
        }>;
        saveAutoFixConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                enabled_for_issues: boolean;
                repository_selection_mode: "all" | "selected";
                enabled_for_review_comments?: boolean | undefined;
                selected_repository_ids?: number[] | undefined;
                skip_labels?: string[] | undefined;
                required_labels?: string[] | undefined;
                model_slug?: string | undefined;
                custom_instructions?: string | null | undefined;
                pr_title_template?: string | undefined;
                pr_body_template?: string | null | undefined;
                pr_base_branch?: string | undefined;
                max_pr_creation_time_minutes?: number | undefined;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
        toggleAutoFixAgent: _trpc_server.TRPCMutationProcedure<{
            input: {
                isEnabled: boolean;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
                isEnabled: boolean;
            }>;
            meta: object;
        }>;
        listTickets: _trpc_server.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                offset?: number | undefined;
                status?: "failed" | "completed" | "cancelled" | "pending" | "running" | undefined;
                classification?: "feature" | "bug" | "question" | "unclear" | undefined;
                repoFullName?: string | undefined;
            };
            output: FailureResult<string> | SuccessResult<ListFixTicketsResponse>;
            meta: object;
        }>;
        retriggerFix: _trpc_server.TRPCMutationProcedure<{
            input: {
                ticketId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
        cancelFix: _trpc_server.TRPCMutationProcedure<{
            input: {
                ticketId: string;
            };
            output: FailureResult<string> | SuccessResult<{
                message: string;
            }>;
            meta: object;
        }>;
    }>>;
    appReportedMessages: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        createReport: _trpc_server.TRPCMutationProcedure<{
            input: {
                message: {
                    [x: string]: unknown;
                };
                cli_session_id: string | null;
                mode: string | null;
                model: string | null;
                report_type: "unparsed" | "unstyled";
            };
            output: {
                report_id: string;
            };
            meta: object;
        }>;
    }>>;
    kiloPass: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        getAverageMonthlyUsageLast3Months: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                averageMonthlyUsageUsd: number;
            };
            meta: object;
        }>;
        getState: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                subscription: {
                    subscriptionId: string;
                    stripeSubscriptionId: string;
                    tier: KiloPassTier;
                    cadence: KiloPassCadence;
                    status: "active" | "canceled" | "trialing" | "past_due" | "unpaid" | "incomplete" | "incomplete_expired" | "paused";
                    cancelAtPeriodEnd: boolean;
                    currentStreakMonths: number;
                    nextYearlyIssueAt: string | null;
                    startedAt: string | null;
                    nextBonusCreditsUsd: number | null;
                    nextBillingAt: string | null;
                    isFirstTimeSubscriberEver: boolean;
                    currentPeriodBaseCreditsUsd: number;
                    currentPeriodUsageUsd: number;
                    currentPeriodBonusCreditsUsd: number | null;
                    isBonusUnlocked: boolean;
                    refillAt: string | null;
                } | null;
                isEligibleForFirstMonthPromo: boolean;
            };
            meta: object;
        }>;
        getCheckoutReturnState: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                subscription: {
                    subscriptionId: string;
                    stripeSubscriptionId: string;
                    tier: KiloPassTier;
                    cadence: KiloPassCadence;
                    status: "active" | "canceled" | "trialing" | "past_due" | "unpaid" | "incomplete" | "incomplete_expired" | "paused";
                    cancelAtPeriodEnd: boolean;
                    currentStreakMonths: number;
                    nextYearlyIssueAt: string | null;
                    startedAt: string | null;
                } | null;
                creditsAwarded: boolean;
            };
            meta: object;
        }>;
        getCustomerPortalUrl: _trpc_server.TRPCMutationProcedure<{
            input: {
                returnUrl?: string | undefined;
            };
            output: {
                url: string;
            };
            meta: object;
        }>;
        cancelSubscription: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        resumeSubscription: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        getScheduledChange: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                scheduledChange: {
                    id: string;
                    fromTier: KiloPassTier;
                    fromCadence: KiloPassCadence;
                    toTier: KiloPassTier;
                    toCadence: KiloPassCadence;
                    effectiveAt: string;
                    status: KiloPassScheduledChangeStatus;
                } | null;
            };
            meta: object;
        }>;
        scheduleChange: _trpc_server.TRPCMutationProcedure<{
            input: {
                targetTier: KiloPassTier;
                targetCadence: KiloPassCadence;
            };
            output: {
                scheduledChangeId: string;
                effectiveAt: string;
            };
            meta: object;
        }>;
        cancelScheduledChange: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        createCheckoutSession: _trpc_server.TRPCMutationProcedure<{
            input: {
                tier: KiloPassTier;
                cadence: KiloPassCadence;
            };
            output: {
                url: string | null;
            };
            meta: object;
        }>;
    }>>;
    agentProfiles: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        list: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            };
            output: {
                id: string;
                name: string;
                description: string | null;
                isDefault: boolean;
                createdAt: string;
                updatedAt: string;
                varCount: number;
                commandCount: number;
            }[];
            meta: object;
        }>;
        listCombined: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId: string;
            };
            output: {
                orgProfiles: {
                    id: string;
                    name: string;
                    description: string | null;
                    isDefault: boolean;
                    createdAt: string;
                    updatedAt: string;
                    varCount: number;
                    commandCount: number;
                    ownerType: "organization" | "user";
                }[];
                personalProfiles: {
                    id: string;
                    name: string;
                    description: string | null;
                    isDefault: boolean;
                    createdAt: string;
                    updatedAt: string;
                    varCount: number;
                    commandCount: number;
                    ownerType: "organization" | "user";
                }[];
                effectiveDefaultId: string | null;
            };
            meta: object;
        }>;
        get: _trpc_server.TRPCQueryProcedure<{
            input: {
                profileId: string;
                organizationId?: string | undefined;
            };
            output: {
                id: string;
                name: string;
                description: string | null;
                isDefault: boolean;
                createdAt: string;
                updatedAt: string;
                vars: {
                    key: string;
                    value: string;
                    isSecret: boolean;
                    createdAt: string;
                    updatedAt: string;
                }[];
                commands: {
                    sequence: number;
                    command: string;
                }[];
            };
            meta: object;
        }>;
        create: _trpc_server.TRPCMutationProcedure<{
            input: {
                name: string;
                description?: string | undefined;
                organizationId?: string | undefined;
            };
            output: {
                id: string;
            };
            meta: object;
        }>;
        update: _trpc_server.TRPCMutationProcedure<{
            input: {
                profileId: string;
                organizationId?: string | undefined;
                name?: string | undefined;
                description?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        delete: _trpc_server.TRPCMutationProcedure<{
            input: {
                profileId: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        setAsDefault: _trpc_server.TRPCMutationProcedure<{
            input: {
                profileId: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        clearDefault: _trpc_server.TRPCMutationProcedure<{
            input: {
                profileId: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        setVar: _trpc_server.TRPCMutationProcedure<{
            input: {
                profileId: string;
                key: string;
                value: string;
                isSecret: boolean;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        deleteVar: _trpc_server.TRPCMutationProcedure<{
            input: {
                profileId: string;
                key: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        setCommands: _trpc_server.TRPCMutationProcedure<{
            input: {
                profileId: string;
                commands: string[];
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
    }>>;
    webhookTriggers: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        list: _trpc_server.TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            };
            output: {
                inboundUrl: string;
                id: string;
                triggerId: string;
                githubRepo: string;
                isActive: boolean;
                createdAt: string;
                updatedAt: string;
            }[];
            meta: object;
        }>;
        get: _trpc_server.TRPCQueryProcedure<{
            input: {
                triggerId: string;
                organizationId?: string | undefined;
            };
            output: {
                inboundUrl: string;
                triggerId: string;
                namespace: string;
                userId: string | null;
                orgId: string | null;
                createdAt: string;
                isActive: boolean;
                githubRepo: string;
                mode: string;
                model: string;
                promptTemplate: string;
                profileId?: string | null;
                autoCommit?: boolean;
                condenseOnComplete?: boolean;
                webhookAuthHeader?: string;
                webhookAuthConfigured: boolean;
            };
            meta: object;
        }>;
        create: _trpc_server.TRPCMutationProcedure<{
            input: {
                triggerId: string;
                githubRepo: string;
                mode: "code" | "architect" | "ask" | "debug" | "orchestrator";
                model: string;
                promptTemplate: string;
                profileId: string;
                organizationId?: string | undefined;
                autoCommit?: boolean | undefined;
                condenseOnComplete?: boolean | undefined;
                webhookAuth?: {
                    header: string;
                    secret: string;
                } | undefined;
            };
            output: {
                id: string;
                triggerId: string;
                githubRepo: string;
                isActive: boolean;
                createdAt: string;
                inboundUrl: string;
            };
            meta: object;
        }>;
        update: _trpc_server.TRPCMutationProcedure<{
            input: {
                triggerId: string;
                organizationId?: string | undefined;
                mode?: "code" | "architect" | "ask" | "debug" | "orchestrator" | undefined;
                model?: string | undefined;
                promptTemplate?: string | undefined;
                profileId?: string | undefined;
                autoCommit?: boolean | null | undefined;
                condenseOnComplete?: boolean | null | undefined;
                isActive?: boolean | undefined;
                webhookAuth?: {
                    header?: string | null | undefined;
                    secret?: string | null | undefined;
                } | undefined;
            };
            output: {
                inboundUrl: string;
                triggerId: string;
                namespace: string;
                userId: string | null;
                orgId: string | null;
                createdAt: string;
                isActive: boolean;
                githubRepo: string;
                mode: string;
                model: string;
                promptTemplate: string;
                profileId?: string | null;
                autoCommit?: boolean;
                condenseOnComplete?: boolean;
                webhookAuthHeader?: string;
                webhookAuthConfigured: boolean;
            };
            meta: object;
        }>;
        delete: _trpc_server.TRPCMutationProcedure<{
            input: {
                triggerId: string;
                organizationId?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        listRequests: _trpc_server.TRPCQueryProcedure<{
            input: {
                triggerId: string;
                organizationId?: string | undefined;
                limit?: number | undefined;
            };
            output: EnrichedCapturedRequest[];
            meta: object;
        }>;
    }>>;
    userFeedback: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        create: _trpc_server.TRPCMutationProcedure<{
            input: {
                feedback_text?: string | undefined;
                feedback_for?: string | undefined;
                feedback_batch?: string | undefined;
                source?: string | undefined;
                context_json?: Record<string, unknown> | undefined;
            };
            output: {
                id: string;
            };
            meta: object;
        }>;
    }>>;
    appBuilderFeedback: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        create: _trpc_server.TRPCMutationProcedure<{
            input: {
                project_id: string;
                feedback_text: string;
                organization_id?: string | undefined;
                model?: string | undefined;
                preview_status?: string | undefined;
                is_streaming?: boolean | undefined;
                message_count?: number | undefined;
                recent_messages?: {
                    role: string;
                    text: string;
                    ts: number;
                }[] | undefined;
            };
            output: {
                id: string;
            };
            meta: object;
        }>;
    }>>;
    cloudAgentNextFeedback: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        create: _trpc_server.TRPCMutationProcedure<{
            input: {
                feedback_text: string;
                cloud_agent_session_id?: string | undefined;
                kilo_session_id?: string | undefined;
                organization_id?: string | undefined;
                model?: string | undefined;
                repository?: string | undefined;
                is_streaming?: boolean | undefined;
                message_count?: number | undefined;
                recent_messages?: {
                    role: string;
                    text: string;
                    ts: number;
                }[] | undefined;
            };
            output: {
                id: string;
            };
            meta: object;
        }>;
    }>>;
    kiloclaw: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        getChangelog: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: ChangelogEntry[];
            meta: object;
        }>;
        serviceDegraded: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: boolean;
            meta: object;
        }>;
        latestVersion: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: ImageVersionEntry | null;
            meta: object;
        }>;
        getStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                name: string | null;
                workerUrl: string;
                userId: string | null;
                sandboxId: string | null;
                status: "provisioned" | "starting" | "restarting" | "running" | "stopped" | "destroying" | null;
                provisionedAt: number | null;
                lastStartedAt: number | null;
                lastStoppedAt: number | null;
                envVarCount: number;
                secretCount: number;
                channelCount: number;
                flyAppName: string | null;
                flyMachineId: string | null;
                flyVolumeId: string | null;
                flyRegion: string | null;
                machineSize: MachineSize | null;
                openclawVersion: string | null;
                imageVariant: string | null;
                trackedImageTag: string | null;
                trackedImageDigest: string | null;
                googleConnected: boolean;
                gmailNotificationsEnabled: boolean;
                execSecurity: string | null;
                execAsk: string | null;
            };
            meta: object;
        }>;
        renameInstance: _trpc_server.TRPCMutationProcedure<{
            input: {
                name: string | null;
            };
            output: void;
            meta: object;
        }>;
        start: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                ok: true;
            };
            meta: object;
        }>;
        stop: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                ok: true;
            };
            meta: object;
        }>;
        destroy: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                ok: true;
            };
            meta: object;
        }>;
        provision: _trpc_server.TRPCMutationProcedure<{
            input: {
                envVars?: Record<string, string> | undefined;
                secrets?: Record<string, string> | undefined;
                channels?: {
                    telegramBotToken?: string | undefined;
                    discordBotToken?: string | undefined;
                    slackBotToken?: string | undefined;
                    slackAppToken?: string | undefined;
                } | undefined;
                kilocodeDefaultModel?: string | null | undefined;
            };
            output: {
                sandboxId: string;
            };
            meta: object;
        }>;
        patchConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                kilocodeDefaultModel?: string | null | undefined;
            };
            output: {
                kilocodeDefaultModel: string | null;
                kilocodeApiKeyExpiresAt: string | null;
            };
            meta: object;
        }>;
        updateConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                envVars?: Record<string, string> | undefined;
                secrets?: Record<string, string> | undefined;
                channels?: {
                    telegramBotToken?: string | undefined;
                    discordBotToken?: string | undefined;
                    slackBotToken?: string | undefined;
                    slackAppToken?: string | undefined;
                } | undefined;
                kilocodeDefaultModel?: string | null | undefined;
            };
            output: {
                sandboxId: string;
            };
            meta: object;
        }>;
        updateKiloCodeConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                kilocodeDefaultModel?: string | null | undefined;
            };
            output: {
                kilocodeDefaultModel: string | null;
                kilocodeApiKeyExpiresAt: string | null;
            };
            meta: object;
        }>;
        patchChannels: _trpc_server.TRPCMutationProcedure<{
            input: {
                telegramBotToken?: string | null | undefined;
                discordBotToken?: string | null | undefined;
                slackBotToken?: string | null | undefined;
                slackAppToken?: string | null | undefined;
            };
            output: ChannelsPatchResponse;
            meta: object;
        }>;
        patchExecPreset: _trpc_server.TRPCMutationProcedure<{
            input: {
                security?: string | undefined;
                ask?: string | undefined;
            };
            output: {
                execSecurity: string | null;
                execAsk: string | null;
            };
            meta: object;
        }>;
        patchSecrets: _trpc_server.TRPCMutationProcedure<{
            input: {
                secrets: Record<string, string | null>;
            };
            output: SecretsPatchResponse;
            meta: object;
        }>;
        getConfig: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: UserConfigResponse;
            meta: object;
        }>;
        getChannelCatalog: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                id: string;
                label: string;
                configured: boolean;
                fields: {
                    key: string;
                    label: string;
                    placeholder: string;
                    placeholderConfigured: string;
                    validationPattern: string | undefined;
                    validationMessage: string | undefined;
                }[];
                helpText: string | undefined;
                helpUrl: string | undefined;
                allFieldsRequired: boolean;
            }[];
            meta: object;
        }>;
        getSecretCatalog: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                id: string;
                label: string;
                configured: boolean;
                fields: {
                    key: string;
                    label: string;
                    placeholder: string;
                    placeholderConfigured: string;
                    validationPattern: string | undefined;
                    validationMessage: string | undefined;
                }[];
                helpText: string | undefined;
                helpUrl: string | undefined;
                allFieldsRequired: boolean;
            }[];
            meta: object;
        }>;
        restartMachine: _trpc_server.TRPCMutationProcedure<{
            input: {
                imageTag?: string | undefined;
            } | undefined;
            output: RestartMachineResponse;
            meta: object;
        }>;
        listPairingRequests: _trpc_server.TRPCQueryProcedure<{
            input: {
                refresh?: boolean | undefined;
            } | undefined;
            output: PairingListResponse;
            meta: object;
        }>;
        approvePairingRequest: _trpc_server.TRPCMutationProcedure<{
            input: {
                channel: string;
                code: string;
            };
            output: PairingApproveResponse;
            meta: object;
        }>;
        listDevicePairingRequests: _trpc_server.TRPCQueryProcedure<{
            input: {
                refresh?: boolean | undefined;
            } | undefined;
            output: DevicePairingListResponse;
            meta: object;
        }>;
        approveDevicePairingRequest: _trpc_server.TRPCMutationProcedure<{
            input: {
                requestId: string;
            };
            output: DevicePairingApproveResponse;
            meta: object;
        }>;
        gatewayStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: GatewayProcessStatusResponse;
            meta: object;
        }>;
        gatewayReady: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: GatewayReadyResponse;
            meta: object;
        }>;
        controllerVersion: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: ControllerVersionResponse;
            meta: object;
        }>;
        restartOpenClaw: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: GatewayProcessActionResponse;
            meta: object;
        }>;
        runDoctor: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: DoctorResponse;
            meta: object;
        }>;
        restoreConfig: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: ConfigRestoreResponse;
            meta: object;
        }>;
        getGoogleSetupCommand: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                command: string;
            };
            meta: object;
        }>;
        disconnectGoogle: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: GoogleCredentialsResponse;
            meta: object;
        }>;
        setGmailNotifications: _trpc_server.TRPCMutationProcedure<{
            input: {
                enabled: boolean;
            };
            output: GmailNotificationsResponse;
            meta: object;
        }>;
        getEarlybirdStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                purchased: boolean;
            };
            meta: object;
        }>;
        createEarlybirdCheckoutSession: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                url: string | null;
            };
            meta: object;
        }>;
        listAvailableVersions: _trpc_server.TRPCQueryProcedure<{
            input: {
                offset?: number | undefined;
                limit?: number | undefined;
            };
            output: {
                items: {
                    openclaw_version: string;
                    variant: string;
                    image_tag: string;
                    description: string | null;
                    published_at: string;
                }[];
                pagination: {
                    offset: number;
                    limit: number;
                    totalCount: number;
                    totalPages: number;
                };
            };
            meta: object;
        }>;
        getMyPin: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                openclaw_version: string | null;
                variant: string | null;
                id: string;
                user_id: string;
                image_tag: string;
                pinned_by: string;
                reason: string | null;
                created_at: string;
                updated_at: string;
            } | null;
            meta: object;
        }>;
        setMyPin: _trpc_server.TRPCMutationProcedure<{
            input: {
                imageTag: string;
                reason?: string | undefined;
            };
            output: {
                id: string;
                updated_at: string;
                created_at: string;
                user_id: string;
                reason: string | null;
                image_tag: string;
                pinned_by: string;
            };
            meta: object;
        }>;
        removeMyPin: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        fileTree: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: FileNode[];
            meta: object;
        }>;
        readFile: _trpc_server.TRPCQueryProcedure<{
            input: {
                path: string;
            };
            output: {
                content: string;
                etag: string;
            };
            meta: object;
        }>;
        writeFile: _trpc_server.TRPCMutationProcedure<{
            input: {
                path: string;
                content: string;
                etag: string;
            };
            output: {
                etag: string;
            };
            meta: object;
        }>;
        patchOpenclawConfig: _trpc_server.TRPCMutationProcedure<{
            input: {
                patch: Record<string, unknown>;
            };
            output: {
                ok: boolean;
            };
            meta: object;
        }>;
        getBillingStatus: _trpc_server.TRPCQueryProcedure<{
            input: void;
            output: {
                hasAccess: boolean;
                accessReason: "trial" | "subscription" | "earlybird" | null;
                trialEligible: false;
                trial: {
                    startedAt: string;
                    endsAt: string;
                    daysRemaining: number;
                    expired: boolean;
                } | null;
                subscription: {
                    plan: "commit" | "standard";
                    status: "active" | "canceled" | "past_due" | "unpaid";
                    cancelAtPeriodEnd: boolean;
                    currentPeriodEnd: string;
                    commitEndsAt: string | null;
                    scheduledPlan: KiloClawScheduledPlan | null;
                    scheduledBy: KiloClawScheduledBy | null;
                } | null;
                earlybird: {
                    purchased: boolean;
                    expiresAt: string;
                    daysRemaining: number;
                } | null;
                instance: {
                    exists: boolean;
                    status: "running" | "stopped" | "provisioned" | "destroying" | null;
                    suspendedAt: string | null;
                    destructionDeadline: string | null;
                    destroyed: boolean;
                } | null;
            };
            meta: object;
        }>;
        createSubscriptionCheckout: _trpc_server.TRPCMutationProcedure<{
            input: {
                plan: "commit" | "standard";
            };
            output: {
                url: string | null;
            };
            meta: object;
        }>;
        cancelSubscription: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        reactivateSubscription: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        switchPlan: _trpc_server.TRPCMutationProcedure<{
            input: {
                toPlan: "commit" | "standard";
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        cancelPlanSwitch: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        createBillingPortalSession: _trpc_server.TRPCMutationProcedure<{
            input: void;
            output: {
                url: string;
            };
            meta: object;
        }>;
    }>>;
    unifiedSessions: _trpc_server.TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: {
            data: {
                zodError: {
                    formErrors: string[];
                    fieldErrors: {};
                } | null;
                upstreamCode: string | undefined;
                code: _trpc_server.TRPC_ERROR_CODE_KEY;
                httpStatus: number;
                path?: string;
                stack?: string;
            };
            message: string;
            code: _trpc_server.TRPC_ERROR_CODE_NUMBER;
        };
        transformer: false;
    }, _trpc_server.TRPCDecorateCreateRouterOptions<{
        list: _trpc_server.TRPCQueryProcedure<{
            input: {
                cursor?: string | undefined;
                limit?: number | undefined;
                createdOnPlatform?: string | string[] | undefined;
                orderBy?: "updated_at" | "created_at" | undefined;
                organizationId?: string | null | undefined;
                includeSubSessions?: boolean | undefined;
            };
            output: {
                cliSessions: {
                    session_id: string;
                    title: string;
                    git_url: string | null;
                    cloud_agent_session_id: string | null;
                    created_on_platform: string;
                    organization_id: string | null;
                    created_at: string;
                    updated_at: string;
                    version: number;
                    last_mode: string | null;
                    last_model: string | null;
                    git_branch: string | null;
                    parent_session_id: string | null;
                    source: "v1" | "v2";
                }[];
                nextCursor: string | null;
            };
            meta: object;
        }>;
        search: _trpc_server.TRPCQueryProcedure<{
            input: {
                search_string: string;
                limit?: number | undefined;
                offset?: number | undefined;
                createdOnPlatform?: string | string[] | undefined;
                organizationId?: string | null | undefined;
                includeSubSessions?: boolean | undefined;
            };
            output: {
                results: {
                    session_id: string;
                    title: string;
                    git_url: string | null;
                    cloud_agent_session_id: string | null;
                    created_on_platform: string;
                    organization_id: string | null;
                    created_at: string;
                    updated_at: string;
                    version: number;
                    last_mode: string | null;
                    last_model: string | null;
                    git_branch: string | null;
                    parent_session_id: string | null;
                    source: "v1" | "v2";
                }[];
                total: number;
                limit: number;
                offset: number;
            };
            meta: object;
        }>;
    }>>;
}>>;
type RootRouter = typeof rootRouter;

export type { RootRouter };
