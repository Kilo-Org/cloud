import { randomUUID } from 'node:crypto';

import {
  agent_configs,
  code_review_memory_proposals,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';

export const usage = '<fake-email>';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-review-memory ${usage}`);
  console.log('Seeds a local-only fake account, editable and read-only review-memory proposals.');
  console.log('Requires a localhost database and SKIP_STRIPE_API=true; never calls a provider.');
  console.log('Open the returned deep links in a signed-in mobile development client.');
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
  const userId = `dev-seed:mobile-review-memory:${email}`;
  const organizationId = 'ada7b676-14c5-4aa1-bc8a-e3a0a677457a';
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
      google_user_name: 'Review memory tester',
      google_user_image_url: '',
      stripe_customer_id: `cus_local_review_memory_${randomUUID()}`,
      has_validation_stytch: false,
      customer_source: 'dev-seed',
    })
    .onConflictDoNothing();
  await db
    .insert(organizations)
    .values({
      id: organizationId,
      name: 'Review memory lab',
      require_seats: false,
    })
    .onConflictDoNothing();
  await db
    .insert(organization_memberships)
    .values({
      organization_id: organizationId,
      kilo_user_id: userId,
      role: 'member',
    })
    .onConflictDoNothing();

  await db
    .delete(code_review_memory_proposals)
    .where(eq(code_review_memory_proposals.owned_by_user_id, userId));
  await db
    .delete(code_review_memory_proposals)
    .where(eq(code_review_memory_proposals.owned_by_organization_id, organizationId));
  await db.delete(agent_configs).where(eq(agent_configs.owned_by_user_id, userId));
  await db.delete(agent_configs).where(eq(agent_configs.owned_by_organization_id, organizationId));
  await db.insert(agent_configs).values([
    {
      owned_by_user_id: userId,
      agent_type: 'code_review',
      platform: 'github',
      config: { review_memory_enabled: true },
      created_by: userId,
    },
    {
      owned_by_organization_id: organizationId,
      agent_type: 'code_review',
      platform: 'github',
      config: { review_memory_enabled: true },
      created_by: userId,
    },
  ]);
  const [openProposal] = await db
    .insert(code_review_memory_proposals)
    .values([
      {
        owned_by_user_id: userId,
        platform: 'github',
        repo_full_name: 'review-lab/notes',
        status: 'open',
        title: 'Keep validation close to inputs',
        rationale: 'Recent feedback favors validating untrusted inputs before business logic.',
        proposed_markdown: 'Validate untrusted inputs at the boundary before using them.',
        positive_count: 3,
        negative_count: 1,
      },
      {
        owned_by_user_id: userId,
        platform: 'github',
        repo_full_name: 'review-lab/archive',
        status: 'change_request_opened',
        title: 'Prefer focused review comments',
        rationale: 'Actionable comments are easier to address.',
        proposed_markdown: 'Keep each review comment focused on one actionable improvement.',
        positive_count: 2,
      },
      {
        owned_by_user_id: userId,
        platform: 'github',
        repo_full_name: 'review-lab/retry',
        status: 'change_request_failed',
        title: 'Explain retry boundaries',
        rationale: 'Retrying non-idempotent work can duplicate effects.',
        proposed_markdown: 'Check idempotency before recommending retries.',
      },
      {
        owned_by_organization_id: organizationId,
        platform: 'github',
        repo_full_name: 'review-lab/team',
        status: 'open',
        title: 'Document service boundaries',
        rationale: 'Reviewers need to know which service owns each invariant.',
        proposed_markdown: 'Call out ownership boundaries when reviewing cross-service changes.',
      },
    ])
    .returning({ id: code_review_memory_proposals.id });
  if (!openProposal) throw new Error('The fixture proposal was not inserted.');
  console.log(
    'This fixture represents: personal editable, failed, opened proposals and a member-only organization proposal.'
  );
  console.log(
    'No integration or provider credentials are seeded. Approval provider effects are not exercised.'
  );
  return {
    email,
    userId,
    proposalId: openProposal.id,
    organizationId,
    deepLink: 'kiloapp:///code-reviewer/personal/review-memory',
    readOnlyDeepLink: `kiloapp:///code-reviewer/${organizationId}/review-memory`,
  };
}
