/**
 * Script to create test organizations with different trial end dates
 * for testing trial nudge banner states.
 *
 * Creates one organization for each distinct trial state:
 * - trial_active (10 days remaining)
 * - trial_ending_soon (5 days remaining)
 * - trial_ending_very_soon (2 days remaining)
 * - trial_expires_today (0 days remaining)
 * - trial_expired_soft (-2 days remaining)
 * - trial_expired_hard (-5 days remaining)
 *
 * Usage:
 *   # Without adding a user (orgs only)
 *   pnpm script:run db create-trial-test-orgs
 *
 *   # With a user email (user will be added as owner to all orgs)
 *   pnpm script:run db create-trial-test-orgs your-email@example.com
 */

import { localDb, localPool } from '@/scripts/lib/local-database';
import { kilocode_users, organization_memberships, organizations } from '@/db/schema';
import type { OrganizationPlan } from '@/lib/organizations/organization-base-types';
import { eq, inArray } from 'drizzle-orm';

type TrialStateConfig = {
  id: string;
  name: string;
  daysRemaining: number;
  state: string;
};

const TRIAL_STATES: TrialStateConfig[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Trial Active - 10 days',
    daysRemaining: 10,
    state: 'trial_active',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Trial Ending Soon - 5 days',
    daysRemaining: 5,
    state: 'trial_ending_soon',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Trial Ending Very Soon - 2 days',
    daysRemaining: 2,
    state: 'trial_ending_very_soon',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Trial Expires Today - 0 days',
    daysRemaining: 0,
    state: 'trial_expires_today',
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Trial Expired Soft - -2 days',
    daysRemaining: -2,
    state: 'trial_expired_soft',
  },
  {
    id: '66666666-6666-4666-8666-666666666666',
    name: 'Trial Expired Hard - -5 days',
    daysRemaining: -5,
    state: 'trial_expired_hard',
  },
];

export async function run(...args: string[]) {
  const [email] = args;

  console.log('Creating test organizations with different trial end dates...\n');

  let user: { id: string; email: string } | null = null;

  if (email) {
    console.log(`Looking up user with email: ${email}`);
    const [existingUser] = await localDb
      .select({
        id: kilocode_users.id,
        email: kilocode_users.google_user_email,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, email));

    if (!existingUser) {
      throw new Error(
        `No user found with email ${email}. Please sign in as that user first so they exist in the local database.`
      );
    }

    user = { id: existingUser.id, email: existingUser.email };
    console.log(`\u2713 Found user ${user.id} (${user.email})`);
  }

  const createdOrgs: Array<{ id: string; name: string; trialEndAt: string; state: string }> = [];

  // Remove memberships first to avoid foreign key issues
  // Ensure idempotency: delete any existing trial orgs we are about to (re)create
  const trialOrgIds = TRIAL_STATES.map(config => config.id);
  console.log('Cleaning up any existing trial test organizations...\n');

  await localDb
    .delete(organization_memberships)
    .where(inArray(organization_memberships.organization_id, trialOrgIds));

  // Then remove the organizations themselves
  await localDb.delete(organizations).where(inArray(organizations.id, trialOrgIds));

  for (const config of TRIAL_STATES) {
    const trialEndAt = calculateTrialEndDate(config.daysRemaining);

    const [org] = await localDb
      .insert(organizations)
      .values({
        id: config.id,
        name: config.name,
        plan: 'enterprise' as OrganizationPlan,
        free_trial_end_at: trialEndAt,
        microdollars_used: 0,
        auto_top_up_enabled: true,
        settings: {},
        seat_count: 0,
        require_seats: false,
      })
      .returning({ id: organizations.id, name: organizations.name });

    if (!org) {
      throw new Error(`Failed to create organization: ${config.name}`);
    }

    // Optionally add the user as an owner of this org
    if (user) {
      await localDb.insert(organization_memberships).values({
        organization_id: org.id,
        kilo_user_id: user.id,
        role: 'owner',
      });
    }

    createdOrgs.push({
      id: org.id,
      name: org.name,
      trialEndAt,
      state: config.state,
    });

    console.log(`\u2713 Created: ${org.name}`);
    console.log(`  ID: ${org.id}`);
    console.log(`  Trial End: ${trialEndAt}`);
    console.log(`  State: ${config.state}`);
    console.log(`  Days Remaining: ${config.daysRemaining}\n`);
  }

  console.log('✅ Successfully created all test organizations:');
  console.log(`   Total: ${createdOrgs.length} organizations\n`);
  console.log('Summary:');
  createdOrgs.forEach(org => {
    console.log(`  - ${org.name} (${org.id})`);
  });

  // Close database connection
  await localPool.end();
}

/**
 * Calculate trial end date from days remaining
 * Sets time to end of day (23:59:59.999) to match TrialEndDateDialog behavior
 */
function calculateTrialEndDate(daysRemaining: number): string {
  const now = new Date();
  const endDate = new Date(now.getTime() + daysRemaining * 24 * 60 * 60 * 1000);

  endDate.setHours(23, 59, 59, 999);

  return endDate.toISOString();
}
