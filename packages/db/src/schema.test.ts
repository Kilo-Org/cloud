import { describe, it } from '@jest/globals';
import { SCHEMA_CHECK_ENUMS } from './schema';

describe('database schema', () => {
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
      KiloPassIssuanceSource: ['stripe_invoice', 'cron'],
      KiloPassIssuanceItemKind: ['base', 'bonus', 'promo_first_month_50pct'],
      KiloPassAuditLogAction: [
        'stripe_webhook_received',
        'kilo_pass_invoice_paid_handled',
        'base_credits_issued',
        'bonus_credits_issued',
        'bonus_credits_skipped_idempotent',
        'first_month_50pct_promo_issued',
        'yearly_monthly_base_cron_started',
        'yearly_monthly_base_cron_completed',
        'issue_yearly_remaining_credits',
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
      AffiliateProvider: ['impact'],
      AffiliateEventType: ['signup', 'trial_start', 'trial_end', 'sale', 'sale_reversal'],
      AffiliateEventDeliveryState: ['queued', 'blocked', 'sending', 'delivered', 'failed'],
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
});
