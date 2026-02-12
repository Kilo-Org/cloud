import * as fs from 'fs';
import * as path from 'path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from './schema';
import { SCHEMA_CHECK_ENUMS } from './schema';

describe('database schema', () => {
  it("should be up to date with migrations (run 'pnpm drizzle generate' if this fails)", async () => {
    const migrationsDir = './src/db/migrations';

    // Get the latest snapshot from the migrations folder
    const journalPath = path.join(migrationsDir, 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const latestEntry = journal.entries[journal.entries.length - 1];
    const latestSnapshotPath = path.join(
      migrationsDir,
      'meta',
      `${latestEntry.idx.toString().padStart(4, '0')}_snapshot.json`
    );
    const latestSnapshot = JSON.parse(fs.readFileSync(latestSnapshotPath, 'utf-8'));

    // Generate current schema state
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
    };

    const actualEnumValues: Record<string, string[]> = {};
    for (const [name, enumObj] of Object.entries(SCHEMA_CHECK_ENUMS)) {
      actualEnumValues[name] = Object.values(enumObj).sort();
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
            `2. Update the expectedEnumValues.${name} snapshot in src/db/schema.test.ts`
        );
      }
    }
  });
});
