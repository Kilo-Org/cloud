/**
 * Generate mock microdollar_usage data for an organization.
 *
 * Usage:
 *   pnpm --filter web script:run usage generate-org-data <orgId>
 *   pnpm --filter web script:run usage generate-org-data <orgId> --reset
 *
 * Flags:
 *   --reset   Delete existing microdollar_usage + metadata attributed to
 *             this organization before inserting new records.
 *
 * If the org has fewer than 15 members, mock users are created and added
 * as `organization_memberships`. Records span the last 13 months with
 * realistic density (heavy recent activity, sparser in older months) and
 * variety across models, providers, features, modes, projects, and users.
 *
 * The Usage Analytics page reads from Snowflake; no further local steps are
 * needed after inserting records with this script.
 */
import { strict as assert } from 'node:assert';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq, isNull, sql, and } from 'drizzle-orm';
import { cliConfirm } from '@/scripts/lib/cli-confirm';
import { ensureOrgHasAtLeast } from './lib/mock-users';
import {
  deleteOrgUsageFor,
  ensureLookupsSeeded,
  generateAndInsertMockUsage,
} from './lib/generate-mock-usage';

const TARGET_MEMBER_COUNT = 15;

type Flags = {
  reset: boolean;
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { reset: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--reset') {
      flags.reset = true;
    } else {
      console.warn(`Unknown flag: ${arg}`);
    }
  }
  return flags;
}

export async function run(...args: string[]): Promise<void> {
  const [orgId, ...rest] = args;
  assert(orgId, 'Organization ID is required as the first argument');
  const flags = parseFlags(rest);

  const org = await db.query.organizations.findFirst({
    where: and(eq(organizations.id, orgId), isNull(organizations.deleted_at)),
  });
  if (!org) {
    throw new Error(`Organization ${orgId} not found (or soft-deleted)`);
  }

  console.log(`Generating mock usage for organization: ${org.name} (${orgId})`);

  if (flags.reset) {
    await cliConfirm(`--reset will DELETE all microdollar_usage rows for this org. Continue?`);
    const { deleted } = await deleteOrgUsageFor(orgId);
    console.log(`Deleted ${deleted} existing microdollar_usage rows.`);
  }

  const { members, created } = await ensureOrgHasAtLeast(orgId, TARGET_MEMBER_COUNT);
  if (created.length > 0) {
    console.log(
      `Created ${created.length} mock users + memberships (org now has ${members.length} members):`
    );
    created.forEach(u => console.log(`  + ${u.name} <${u.email}>`));
  } else {
    console.log(`Org already has ${members.length} members (target ${TARGET_MEMBER_COUNT}).`);
  }

  const lookups = await ensureLookupsSeeded();

  const stats = await generateAndInsertMockUsage(
    {
      kiloUserIds: members.map(m => m.userId),
      organizationId: orgId,
    },
    lookups
  );

  // Top up the org balance to cover the fake usage (same pattern as
  // seed-fake-usage-for-org.ts): ensure acquired - used >= totalCost + $1.
  const currentBalance = Number(org.total_microdollars_acquired) - Number(org.microdollars_used);
  const requiredBalance = stats.totalCostMicrodollars + 1_000_000;
  if (currentBalance < requiredBalance) {
    const delta = requiredBalance - currentBalance;
    console.log(
      `Topping up org balance by ${delta} microdollars ($${(delta / 1_000_000).toFixed(2)}).`
    );
    await db
      .update(organizations)
      .set({
        total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${delta}`,
        microdollars_balance: sql`${organizations.microdollars_balance} + ${delta}`,
      })
      .where(eq(organizations.id, orgId));
  } else {
    console.log(
      `Org balance already covers generated cost (balance ${currentBalance} >= required ${requiredBalance}).`
    );
  }

  console.log('');
  console.log(`Done. Inserted ${stats.recordCount} usage records.`);
  console.log('');
  console.log(
    'Usage Analytics reads from Snowflake; point the sandbox env at DBT_BACKEND_SANDBOX to see data.'
  );
}
