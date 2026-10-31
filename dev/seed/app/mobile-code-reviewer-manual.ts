import { randomUUID } from 'node:crypto';

import { kilocode_users, platform_integrations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-code-reviewer-manual ${usage}`);
  console.log('');
  console.log('Seeds a local-only fake account whose personal Code Reviewer scope has');
  console.log('GitLab connected and GitHub not connected, so the manual-review form opens');
  console.log('on GitLab with the GitHub platform option disabled.');
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
  const userId = `dev-seed:mobile-code-reviewer-manual:${email}`;

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
      google_user_name: 'Manual review tester',
      google_user_image_url: '',
      // Placeholder customer: this fixture never reaches a Stripe call, and the
      // column has no default.
      stripe_customer_id: `cus_local_manual_review_${randomUUID()}`,
      // Skip the web verification and customer-source gates a seeded user
      // would otherwise bounce through (`dev/seed/AGENTS.md`, Direct user
      // inserts).
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();

  // Reconnect from scratch on every run: the fixture owns exactly one personal
  // GitLab row and no GitHub row, which is the state the screen shows when one
  // platform is connected and the other is not.
  await db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_user_id, userId),
        eq(platform_integrations.platform, 'gitlab')
      )
    );
  await db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_user_id, userId),
        eq(platform_integrations.platform, 'github')
      )
    );

  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: userId,
      created_by_user_id: userId,
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_account_id: 'dev-seed-gitlab-account',
      platform_account_login: 'manual-review-lab',
      repository_access: 'all',
      repositories: [],
      integration_status: 'active',
      metadata: { gitlab_instance_url: 'https://gitlab.com' },
    })
    .returning({ id: platform_integrations.id });
  if (!integration) throw new Error('The fixture GitLab integration was not inserted.');

  console.log(
    'This fixture represents: a personal Code Reviewer scope with GitLab connected and GitHub absent.'
  );
  console.log(
    'No provider credential is stored, so the form is reachable while a real review start would not be.'
  );

  return {
    email,
    userId,
    gitlabIntegrationId: integration.id,
    manualReviewDeepLink: 'kiloapp:///code-reviewer/personal/manual-review',
  };
}
