import { computeDatabaseUrl } from '@kilocode/db';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

const USER_ID = 'user_pr_entry_ux_20261030';
const EMAIL = 'pr-entry-ux-20261030@example.com';
const ORGANIZATIONS = [
  { id: '527d8278-1000-4000-8000-000020261030', name: 'Acme' },
  {
    id: '527d8278-2000-4000-8000-000020261030',
    name: 'Acme International Platform Engineering',
  },
];

function printUsage(): void {
  console.log('Usage: pnpm dev:seed app:mobile-pr-entry');
  console.log('Seeds an owned fake account and short and long organization names.');
  console.log('Requires a loopback database and SKIP_STRIPE_API=true. No provider is connected.');
  console.log('Sign in with email, then open kiloapp:///dev/pr-review-entry-fixture.');
  console.log('Use ?state=empty to check the empty history. Avoid billing surfaces.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.length > 0) {
    throw new Error('The mobile PR entry seed takes no arguments.');
  }
  const databaseUrl = new URL(computeDatabaseUrl());
  if (
    process.env.USE_PRODUCTION_DB === 'true' ||
    process.env.SKIP_STRIPE_API !== 'true' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname)
  ) {
    throw new Error(
      'The mobile PR entry seed requires an isolated loopback database and disabled Stripe.'
    );
  }
  const db = getSeedDb();
  const [existing] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, EMAIL));
  if (existing && existing.id !== USER_ID) {
    throw new Error('The fixture email belongs to a different account.');
  }
  await db
    .insert(kilocode_users)
    .values({
      id: USER_ID,
      google_user_email: EMAIL,
      google_user_name: 'PR Entry UX',
      google_user_image_url: '',
      stripe_customer_id: 'cus_local_pr_entry_ux_20261030',
      has_validation_stytch: true,
      customer_source: 'dev-seed',
      normalized_email: EMAIL,
      email_domain: 'example.com',
    })
    .onConflictDoNothing();
  for (const organization of ORGANIZATIONS) {
    await db
      .insert(organizations)
      .values({
        ...organization,
        created_by_kilo_user_id: USER_ID,
        require_seats: false,
      })
      .onConflictDoNothing();
    await db
      .insert(organization_memberships)
      .values({ organization_id: organization.id, kilo_user_id: USER_ID, role: 'owner' })
      .onConflictDoNothing();
  }
  console.log('This fixture represents recent reviews under personal and organization accounts.');
  console.log('No Stripe customer or provider integration is created. Avoid billing surfaces.');
  return {
    email: EMAIL,
    userId: USER_ID,
    shortOrganizationId: ORGANIZATIONS[0].id,
    longOrganizationId: ORGANIZATIONS[1].id,
    deepLink: 'kiloapp:///dev/pr-review-entry-fixture',
    emptyDeepLink: 'kiloapp:///dev/pr-review-entry-fixture?state=empty',
  };
}
