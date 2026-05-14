/**
 * Generate mock microdollar_usage data for a single user (personal scope).
 *
 * Usage:
 *   pnpm --filter web script:run usage generate-user-data <userId>
 *   pnpm --filter web script:run usage generate-user-data <userId> --reset
 *
 * Flags:
 *   --reset   Delete existing personal-scope (organization_id IS NULL)
 *             microdollar_usage + metadata for this user before inserting.
 *
 * All generated records have `organization_id = NULL`. Records span the
 * last 13 months with realistic density and variety across models,
 * providers, features, modes, and projects.
 *
 * The Usage Analytics page reads from Snowflake; no further local steps are
 * needed after inserting records with this script.
 */
import { strict as assert } from 'node:assert';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { cliConfirm } from '@/scripts/lib/cli-confirm';
import {
  deletePersonalUsageFor,
  ensureLookupsSeeded,
  generateAndInsertMockUsage,
} from './lib/generate-mock-usage';

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
  const [userId, ...rest] = args;
  assert(userId, 'User ID is required as the first argument');
  const flags = parseFlags(rest);

  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  console.log(
    `Generating personal-scope mock usage for user: ${user.google_user_name} <${user.google_user_email}> (${userId})`
  );

  if (flags.reset) {
    await cliConfirm(
      `--reset will DELETE all personal-scope microdollar_usage rows for this user. Continue?`
    );
    const { deleted } = await deletePersonalUsageFor(userId);
    console.log(`Deleted ${deleted} existing personal-scope microdollar_usage rows.`);
  }

  const lookups = await ensureLookupsSeeded();

  const stats = await generateAndInsertMockUsage(
    {
      kiloUserIds: [userId],
      organizationId: null,
    },
    lookups
  );

  console.log('');
  console.log(`Done. Inserted ${stats.recordCount} usage records.`);
  console.log('');
  console.log(
    'Usage Analytics reads from Snowflake; point the sandbox env at DBT_BACKEND_SANDBOX to see data.'
  );
}
