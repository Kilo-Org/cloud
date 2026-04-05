import { db } from '@/lib/drizzle';
import { organizations, kilocode_users, type Organization } from '@kilocode/db/schema';
import { isNull, eq, and, or, gt, gte, sql } from 'drizzle-orm';
import { updateOrganizationSettings } from '@/lib/organizations/organizations';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { cliConfirm } from '@/scripts/lib/cli-confirm';

/**
 * Fetch organizations in free trial (created less than 40 days ago)
 * Only includes organizations with deleted_at IS NULL and code indexing not enabled
 */
async function getTrialOrgs(): Promise<Organization[]> {
  const fortyDaysAgo = new Date();
  fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);

  return db
    .select()
    .from(organizations)
    .where(
      and(
        isNull(organizations.deleted_at),
        gte(organizations.created_at, fortyDaysAgo.toISOString()),
        or(
          isNull(organizations.settings),
          sql`(${organizations.settings}->>'code_indexing_enabled')::boolean IS NOT TRUE`
        )
      )
    );
}
/**
 * Fetch organizations with seats (seat_count > 0)
 * Only includes organizations with deleted_at IS NULL and code indexing not enabled
 */
async function getOrgsWithSeats(): Promise<Organization[]> {
  return db
    .select()
    .from(organizations)
    .where(
      and(
        isNull(organizations.deleted_at),
        gt(organizations.seat_count, 0),
        or(
          isNull(organizations.settings),
          sql`(${organizations.settings}->>'code_indexing_enabled')::boolean IS NOT TRUE`
        )
      )
    );
}

/**
 * Enable code indexing for a list of organizations
 */
async function enableCodeIndexingForOrgs(
  orgs: Organization[],
  adminUserId: string,
  adminEmail: string,
  adminName: string
): Promise<{ successCount: number; errorCount: number }> {
  let successCount = 0;
  let errorCount = 0;

  for (const org of orgs) {
    try {
      process.stdout.write(
        `   [${successCount + errorCount + 1}/${orgs.length}] ${org.name} (${org.id})... `
      );

      // Get current settings
      const currentSettings = org.settings || {};

      // Update settings to enable code indexing
      await updateOrganizationSettings(org.id, {
        ...currentSettings,
        code_indexing_enabled: true,
      });

      // Create audit log
      await createAuditLog({
        action: 'organization.settings.change',
        actor_email: adminEmail,
        actor_id: adminUserId,
        actor_name: adminName,
        message: '[Script] Code indexing: enabled',
        organization_id: org.id,
      });

      console.log('✅ enabled');
      successCount++;
    } catch (error) {
      console.log(`❌ ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.error('');
      console.error(`   Error details for ${org.name} (${org.id}):`);
      console.error(`   ${error instanceof Error ? error.stack : String(error)}`);
      console.error('');
      errorCount++;
    }
  }

  return { successCount, errorCount };
}

/**
 * Enable code indexing for eligible organizations
 * Eligible organizations are:
 * 1. Organizations in free trial (created < 40 days ago)
 * 2. Enterprise plan organizations
 * 3. Organizations with seats (seat_count > 0)
 *
 * Usage:
 *   pnpm script:run managed-indexing enable-orgs
 */
export async function run(): Promise<void> {
  console.log('🚀 Starting code indexing enablement for eligible organizations...');
  console.log('');

  // Fetch the specific admin user for audit logs
  const adminUser = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, 'brian@kilocode.ai'))
    .limit(1);

  if (!adminUser || adminUser.length === 0) {
    throw new Error('Admin user brian@kilocode.ai not found');
  }

  const admin = adminUser[0];
  console.log(`   Using admin user: ${admin.google_user_email}`);
  console.log('');

  // Fetch organizations by category
  console.log('📋 Fetching organizations to enable...');

  // Comment out any categories you don't want to enable
  const trialOrgs = await getTrialOrgs();
  const seatsOrgs = await getOrgsWithSeats();

  // Combine all categories (comment out lines to exclude specific categories)
  const allOrgs = [...trialOrgs, ...seatsOrgs];

  // Remove duplicates (in case an org matches multiple categories)
  const uniqueOrgs = Array.from(new Map(allOrgs.map(org => [org.id, org])).values());

  console.log(
    `   Found ${uniqueOrgs.length} eligible organizations (without code indexing enabled):`
  );
  console.log(`   - ${trialOrgs.length} in free trial (< 40 days old)`);
  console.log(`   - ${seatsOrgs.length} with seats`);
  console.log('');

  if (uniqueOrgs.length === 0) {
    console.log('✅ No eligible organizations found. Nothing to do.');
    return;
  }

  // Prompt for confirmation
  await cliConfirm(`Do you want to enable code indexing for ${uniqueOrgs.length} organizations?`);
  console.log('');

  // Enable code indexing for all organizations
  console.log('🔧 Enabling code indexing...');
  const { successCount, errorCount } = await enableCodeIndexingForOrgs(
    uniqueOrgs,
    admin.id,
    admin.google_user_email,
    admin.google_user_name
  );

  console.log('');
  console.log('📊 Summary:');
  console.log(`   ✅ Success: ${successCount} organizations`);
  console.log(`   ❌ Errors: ${errorCount} organizations`);
  console.log(`   📦 Total: ${uniqueOrgs.length} organizations`);
  console.log('');

  if (errorCount > 0) {
    console.log('⚠️  Some organizations failed to update. Check the error details above.');
    process.exit(1);
  }

  console.log('✨ Code indexing enablement complete!');
}
