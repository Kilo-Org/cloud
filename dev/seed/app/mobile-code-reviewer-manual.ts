import { randomUUID } from 'node:crypto';

import {
  kilocode_users,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { fakeGitLabOAuthCredential } from '../lib/gitlab-credential';
import { findSeedUserId } from '../lib/users';

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
  assertLocalSeedDatabase('app:mobile-code-reviewer-manual');
  if (process.env.SKIP_STRIPE_API !== 'true') {
    throw new Error(
      'This fixture requires an isolated loopback database and SKIP_STRIPE_API=true.'
    );
  }

  const db = getSeedDb();
  // A fake account that already signed in keeps its own row: the fixture joins
  // it, so the seed runs before or after the device-code sign-in.
  const userId = (await findSeedUserId(email)) ?? `dev-seed:mobile-code-reviewer-manual:${email}`;
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

  // The status read asks git-token-service for the stored credential (#8044),
  // so an active row alone reads as "reconnect required" and the form never
  // opens. The fixture stores a placeholder credential the local worker
  // decrypts.
  const integrationId = randomUUID();
  const account = { id: 'dev-seed-gitlab-account', login: 'manual-review-lab' };
  const providerBaseUrl = 'https://gitlab.com';
  const credential = fakeGitLabOAuthCredential({
    integrationId,
    userId,
    providerBaseUrl,
    providerSubjectId: account.id,
    providerSubjectLogin: account.login,
  });
  await db.transaction(async tx => {
    await tx.insert(platform_integrations).values({
      id: integrationId,
      owned_by_user_id: userId,
      created_by_user_id: userId,
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_account_id: account.id,
      platform_account_login: account.login,
      repository_access: 'all',
      repositories: [],
      integration_status: 'active',
      metadata: { gitlab_instance_url: providerBaseUrl },
    });
    await tx.insert(platform_oauth_credentials).values(credential);
  });

  console.log(
    'This fixture represents: a personal Code Reviewer scope with GitLab connected and GitHub absent.'
  );
  console.log(
    'Note: the stored GitLab credential is a placeholder, so the form opens while a real review start fails at GitLab.'
  );

  return {
    email,
    userId,
    gitlabIntegrationId: integrationId,
    manualReviewDeepLink: 'kiloapp:///(app)/code-reviewer/personal/manual-review',
  };
}
