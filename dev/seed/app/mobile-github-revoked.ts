import {
  kilocode_users,
  organization_memberships,
  organizations,
  user_github_app_tokens,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

const USER_ID = 'user_mobile_pr_reconnect_20261123';
const EMAIL = 'pr-reconnect-20261123@example.com';
const ORGANIZATION_ID = '527d8278-3000-4000-8000-000020261123';
const GITHUB_USER_ID = '520000000000000001';

function printUsage(): void {
  console.log('Usage: pnpm dev:seed app:mobile-github-revoked');
  console.log('Seeds an owned fake account with a revoked GitHub user authorization.');
  console.log('Requires a loopback database and SKIP_STRIPE_API=true; never calls a provider.');
  console.log('Sign in with email, then open kiloapp:///(app)/pr-review.');
  console.log('The INBOX section shows the expired GitHub connection notice.');
}

/**
 * The state the PR inbox connection notice renders for: a signed-in reviewer
 * whose GitHub user authorization is already revoked. The token row keeps the
 * shape `githubApps.getUserAuthorization` reads (`revoked_at` set, a provided
 * token with no refresh pair), so the notice, the detail gates and the server
 * agree that the connection cannot serve a review. The organization exists so
 * the account switcher offers the context the finding was observed in; the
 * GitHub authorization is the caller's own and does not depend on it.
 */
export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.length > 0) {
    throw new Error('The mobile GitHub revoked seed takes no arguments.');
  }
  assertLocalSeedDatabase('app:mobile-github-revoked');
  if (process.env.SKIP_STRIPE_API !== 'true') {
    throw new Error(
      'The mobile GitHub revoked seed requires an isolated loopback database and disabled Stripe.'
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
      google_user_name: 'PR Reconnect',
      google_user_image_url: '',
      stripe_customer_id: 'cus_local_pr_reconnect_20261123',
      has_validation_stytch: true,
      customer_source: 'dev-seed',
      normalized_email: EMAIL,
      email_domain: 'example.com',
    })
    .onConflictDoNothing();
  await db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      name: 'PR Reconnect',
      created_by_kilo_user_id: USER_ID,
      require_seats: false,
    })
    .onConflictDoNothing();
  await db
    .insert(organization_memberships)
    .values({ organization_id: ORGANIZATION_ID, kilo_user_id: USER_ID, role: 'owner' })
    .onConflictDoNothing();
  const revokedAt = new Date().toISOString();
  await db
    .insert(user_github_app_tokens)
    .values({
      kilo_user_id: USER_ID,
      github_app_type: 'standard',
      credential_source: 'provided_token',
      github_user_id: GITHUB_USER_ID,
      github_login: 'pr-reconnect-fixture',
      access_token_encrypted: 'dev-seed-revoked-token',
      revoked_at: revokedAt,
      revocation_reason: 'dev-seed',
    })
    .onConflictDoUpdate({
      target: [user_github_app_tokens.kilo_user_id, user_github_app_tokens.github_app_type],
      set: { revoked_at: revokedAt, revocation_reason: 'dev-seed' },
    });
  console.log('This fixture represents a reviewer whose GitHub authorization is revoked.');
  console.log('No Stripe customer or provider integration is created. Avoid billing surfaces.');
  return {
    email: EMAIL,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    deepLink: 'kiloapp:///(app)/pr-review',
  };
}
