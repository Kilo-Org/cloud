import { randomUUID } from 'node:crypto';

import {
  credit_transactions,
  kilocode_users,
  organization_memberships,
  organizations,
  user_auth_provider,
} from '@kilocode/db/schema';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<run-id> --expected-db-port=<port> --expected-db-name=<name>';

type Options = {
  runId: string;
  expectedDbPort: string;
  expectedDbName: string;
};

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:onprem-mvp ${usage}`);
  console.log('Creates a non-admin fake-login owner, a 14-day teams trial and $10 of org credit.');
  console.log('run-id: 1-48 lowercase letters, digits or hyphens; start with a letter or digit.');
  console.log('Pass the expected DB port/name only after verifying this worktree owns the DB.');
  console.log('Repeated run IDs fail. Existing data is never updated, deleted or reused.');
  console.log('DB-only: the Stripe customer is a local placeholder, not usable for billing.');
}

function parseOptions(args: string[]): Options {
  const [runId, ...flags] = args;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(runId)) {
    throw new Error('A unique run-id of 1-48 lowercase letters, digits or hyphens is required.');
  }

  let expectedDbPort: string | undefined;
  let expectedDbName: string | undefined;
  for (const flag of flags) {
    if (flag.startsWith('--expected-db-port=') && expectedDbPort === undefined) {
      expectedDbPort = flag.slice('--expected-db-port='.length);
    } else if (flag.startsWith('--expected-db-name=') && expectedDbName === undefined) {
      expectedDbName = flag.slice('--expected-db-name='.length);
    } else {
      throw new Error(
        'Only one --expected-db-port=<port> and --expected-db-name=<name> are allowed.'
      );
    }
  }

  if (!expectedDbPort || !expectedDbName) {
    throw new Error('--expected-db-port=<port> and --expected-db-name=<name> are required.');
  }

  return { runId, expectedDbPort, expectedDbName };
}

export function assertLocalDatabaseTarget(expectedDbPort: string, expectedDbName: string): void {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === 'production' || nodeEnv === 'test') {
    throw new Error('On-prem MVP seed refuses NODE_ENV=production or test.');
  }
  if (process.env.USE_PRODUCTION_DB?.trim().toLowerCase() === 'true') {
    throw new Error('On-prem MVP seed refuses USE_PRODUCTION_DB=true.');
  }
  if (!/^[1-9][0-9]{0,4}$/.test(expectedDbPort) || Number(expectedDbPort) > 65535) {
    throw new Error('--expected-db-port must be an explicit integer from 1 to 65535.');
  }
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(expectedDbName)) {
    throw new Error('--expected-db-name must be 1-63 letters, digits, underscores or hyphens.');
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(process.env.POSTGRES_URL ?? '');
  } catch {
    throw new Error('POSTGRES_URL must be a valid explicit local PostgreSQL URL.');
  }

  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) ||
    databaseUrl.port !== expectedDbPort ||
    databaseUrl.pathname !== `/${expectedDbName}` ||
    databaseUrl.search !== '' ||
    databaseUrl.hash !== ''
  ) {
    throw new Error(
      'POSTGRES_URL must use a loopback host and exactly match the expected DB port/name, without query or fragment.'
    );
  }
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { runId, expectedDbPort, expectedDbName } = parseOptions(args);
  assertLocalDatabaseTarget(expectedDbPort, expectedDbName);

  const userId = `dev-seed:onprem-mvp:${runId}`;
  const email = `kilo-${runId}@example.com`;
  const name = `On-prem MVP ${runId}`;
  const avatarUrl =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="gray"/></svg>'
    );
  const organizationId = randomUUID();
  const membershipId = randomUUID();
  const creditTransactionId = randomUUID();
  const balanceMicrodollars = 10_000_000;
  const freeTrialEndAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const db = getSeedDb();
    await db.transaction(async tx => {
      await tx.insert(kilocode_users).values({
        id: userId,
        google_user_email: email,
        normalized_email: normalizeSeedEmail(email),
        google_user_name: name,
        google_user_image_url: avatarUrl,
        stripe_customer_id: `cus_local_onprem_mvp_${runId}`,
        hosted_domain: '@@fake@@',
        is_admin: false,
        is_super_admin: false,
        has_validation_stytch: true,
        customer_source: 'dev-seed',
        auto_top_up_enabled: false,
        total_microdollars_acquired: 0,
        microdollars_used: 0,
      } satisfies typeof kilocode_users.$inferInsert);

      await tx.insert(organizations).values({
        id: organizationId,
        name: `[dev-seed:onprem-mvp] ${runId}`,
        plan: 'teams',
        require_seats: true,
        free_trial_end_at: freeTrialEndAt,
        created_by_kilo_user_id: userId,
        stripe_customer_id: null,
        auto_top_up_enabled: false,
        total_microdollars_acquired: balanceMicrodollars,
        microdollars_balance: balanceMicrodollars,
        microdollars_used: 0,
      } satisfies typeof organizations.$inferInsert);

      await tx.insert(organization_memberships).values({
        id: membershipId,
        organization_id: organizationId,
        kilo_user_id: userId,
        role: 'owner',
      } satisfies typeof organization_memberships.$inferInsert);

      await tx.insert(user_auth_provider).values({
        kilo_user_id: userId,
        provider: 'fake-login',
        provider_account_id: `fake-${email}`,
        email,
        avatar_url: avatarUrl,
        display_name: name,
        hosted_domain: '@@fake@@',
      } satisfies typeof user_auth_provider.$inferInsert);

      await tx.insert(credit_transactions).values({
        id: creditTransactionId,
        kilo_user_id: userId,
        organization_id: organizationId,
        created_by_kilo_user_id: userId,
        amount_microdollars: balanceMicrodollars,
        is_free: true,
        credit_category: `dev-seed:onprem-mvp:${runId}:credit`,
        description: 'Local on-prem MVP organization credit',
        original_baseline_microdollars_used: 0,
        expiration_baseline_microdollars_used: null,
        stripe_payment_id: null,
        expiry_date: null,
        check_category_uniqueness: true,
      } satisfies typeof credit_transactions.$inferInsert);
    });
  } catch {
    throw new Error(
      `On-prem MVP seed failed for run ${runId} (user ${userId}, email ${email}). ` +
        'Reconcile this run in the verified local DB before retrying; existing data is never reused.'
    );
  }

  return {
    runId,
    userId,
    email,
    organizationId,
    membershipId,
    creditTransactionId,
    role: 'owner',
    balanceMicrodollars,
  };
}
