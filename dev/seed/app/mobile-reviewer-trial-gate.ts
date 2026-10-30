import { randomUUID } from 'node:crypto';

import {
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

/**
 * The organization this fixture owns. The trial is hard-expired (no seat
 * purchase, seats still required) so every organization mutation is refused
 * with `FORBIDDEN` / `Organization trial has expired.` — the state a mobile
 * code-reviewer config save has to explain.
 */
const ORGANIZATION_ID = 'd4f3b5c1-0000-4000-8000-6a7b8c9d0e01';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-reviewer-trial-gate ${usage}`);
  console.log(
    'Seeds a local-only fake owner and an organization whose trial ended, with a GitHub App integration.'
  );
  console.log('Requires a localhost database and SKIP_STRIPE_API=true; never calls a provider.');
  console.log('Open the returned deep link in a signed-in mobile development client.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [email, ...extra] = args;
  if (!email || extra.length || !/^kilo-[a-z0-9-]+@example\.com$/.test(email)) {
    printUsage();
    throw new Error('Provide one owned fake email matching kilo-<name>@example.com.');
  }
  const databaseUrl = new URL(process.env.POSTGRES_URL ?? '');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) ||
    process.env.NODE_ENV === 'production' ||
    process.env.SKIP_STRIPE_API !== 'true'
  ) {
    throw new Error('This fixture requires a local development database and SKIP_STRIPE_API=true.');
  }
  const db = getSeedDb();
  const userId = `dev-seed:mobile-reviewer-trial-gate:${email}`;
  const [existing] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, email));
  if (existing && existing.id !== userId) {
    throw new Error('The requested email belongs to a different account; choose a new fake email.');
  }
  await db
    .insert(kilocode_users)
    .values({
      id: userId,
      google_user_email: email,
      normalized_email: email,
      google_user_name: 'Trial gate owner',
      google_user_image_url: '',
      stripe_customer_id: `cus_local_reviewer_trial_${randomUUID()}`,
      has_validation_stytch: false,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();
  // An organization that never got a seat subscription and whose trial ended
  // more than three days ago: `classifyOrganizationEntitlement` reports
  // `trial_expired_hard` with no bypass, so everything but reads is refused.
  await db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      name: 'Reviewer trial gate lab',
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      created_by_kilo_user_id: userId,
      free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      require_seats: true,
      plan: 'teams',
      settings: {},
    })
    .onConflictDoNothing();
  await db
    .insert(organization_memberships)
    .values({
      organization_id: ORGANIZATION_ID,
      kilo_user_id: userId,
      role: 'owner',
    })
    .onConflictDoNothing();
  // The reviewer config is read from the platform integration; without one the
  // settings screens show the connect card instead of the option rows.
  await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: ORGANIZATION_ID,
      created_by_user_id: userId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: `dev-seed-${ORGANIZATION_ID}`,
      platform_account_id: '770001',
      platform_account_login: 'drain-e2e-labs',
      repository_access: 'all',
      repositories: [
        { id: 900000101, name: 'notes', full_name: 'drain-e2e-labs/notes', private: false },
      ] satisfies { id: number; name: string; full_name: string; private: boolean }[],
      repositories_synced_at: new Date().toISOString(),
      integration_status: 'active',
      github_app_type: 'standard',
      github_connection_role: 'workflow',
    })
    .onConflictDoNothing();

  console.log('This fixture represents: an organization whose trial ended, seen by its owner.');
  console.log('Supported saves are refused with the trial sentence; reads still work.');
  console.log('Suggested next step: open the gate screen deep link on the signed-in app.');
  return {
    userId,
    organizationId: ORGANIZATION_ID,
    organizationName: 'Reviewer trial gate lab',
    deepLink: `kiloapp:///code-reviewer/${ORGANIZATION_ID}/github/gate`,
  };
}
