import { randomUUID } from 'node:crypto';

import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';

export const usage = '<test-email> <other-owner-email>';

/**
 * Two organizations that give the organization screens their empty and their
 * permission-denied states, for one account:
 *
 * - `EMPTY_ORGANIZATION_ID` is an enterprise organization the test account owns
 *   alone, with no groups, modes, audit entries, request logs, credit
 *   transactions, usage rows or model configuration. Every list the app reads is
 *   therefore empty for it: groups, modes, audit log, request logs, credit
 *   activity, usage and providers-and-models.
 * - `MEMBER_ORGANIZATION_ID` is an enterprise organization the test account is a
 *   plain member of, and the second account owns. The screens gate their actions
 *   on the caller's role, so the same lists answer with their permission-denied
 *   copy: audit log and request logs need a billing role, and the organization
 *   hub offers no management rows.
 *
 * Both organizations sit inside their trial so a read is never refused for an
 * expired trial, and neither calls a provider: no subscription, no Stripe
 * customer, no seat purchase.
 *
 * The members list has no seedable empty state: it empties only when an
 * organization has no active member rows, which needs a membership on a bot
 * account (`getOrganizationMembers` filters `is_bot = true`), and a bot account
 * cannot sign in. The child-organization route is no substitute — the app reads
 * `organizations.list`, which nests inherited children instead of listing them
 * as selectable organizations.
 *
 * A rerun updates the two organization rows and leaves the two memberships.
 */
const EMPTY_ORGANIZATION_ID = '5c1e7a90-0000-4000-8000-8b1c2d3e4f01';
const MEMBER_ORGANIZATION_ID = '5c1e7a90-0000-4000-8000-8b1c2d3e4f02';

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-org-states ${usage}`);
  console.log('');
  console.log('Seeds an enterprise organization the test account owns with no rows (every list');
  console.log('empty), and an enterprise organization it is a plain member of (role-gated');
  console.log('screens denied). Requires a localhost database; never calls a provider.');
  console.log('');
  console.log('Open the hub link for an organization first: it persists the selection the');
  console.log('other organization screens read.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [testEmail, otherEmail, ...extra] = args;
  const fakeEmail = /^kilo-[a-z0-9-]+@example\.com$/;
  if (
    !testEmail ||
    !otherEmail ||
    extra.length ||
    ![testEmail, otherEmail].every(email => fakeEmail.test(email))
  ) {
    printUsage();
    throw new Error('Pass two distinct fake emails: the test account and the other owner.');
  }
  if (testEmail === otherEmail) {
    throw new Error('Pass two distinct fake emails: the test account and the other owner.');
  }
  assertLocalSeedDatabase('app:mobile-org-states');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This fixture requires a local development database.');
  }

  const db = getSeedDb();
  const people = [
    {
      email: testEmail.trim(),
      id: `dev-seed:mobile-org-states:${normalizeSeedEmail(testEmail)}`,
      name: 'Org states lab',
    },
    {
      email: otherEmail.trim(),
      id: `dev-seed:mobile-org-states:${normalizeSeedEmail(otherEmail)}`,
      name: 'Org states lab owner',
    },
  ];

  // An account that already exists keeps its id, so a harness that creates the
  // two accounts once (`app:create-user`) can run this topic against them; only a
  // missing account gets this topic's own id.
  const resolved: { email: string; id: string; name: string }[] = [];
  for (const person of people) {
    const [existing] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.normalized_email, normalizeSeedEmail(person.email)));
    if (existing) {
      resolved.push({ email: person.email.trim(), id: existing.id, name: person.name });
      continue;
    }
    await db.insert(kilocode_users).values({
      id: person.id,
      google_user_email: person.email,
      normalized_email: normalizeSeedEmail(person.email),
      google_user_name: person.name,
      google_user_image_url: '',
      stripe_customer_id: `cus_local_org_states_${randomUUID()}`,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    });
    resolved.push({ email: person.email, id: person.id, name: person.name });
  }

  const [testUser, otherUser] = resolved;
  await db
    .insert(organizations)
    .values({
      id: EMPTY_ORGANIZATION_ID,
      name: 'Juniper Works',
      created_by_kilo_user_id: testUser.id,
      free_trial_end_at: daysFromNow(10),
      require_seats: false,
      seat_count: 1,
      plan: 'enterprise',
      auto_top_up_enabled: false,
      settings: {},
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: { free_trial_end_at: daysFromNow(10), plan: 'enterprise' },
    });

  await db
    .insert(organizations)
    .values({
      id: MEMBER_ORGANIZATION_ID,
      name: 'Alder Works',
      created_by_kilo_user_id: otherUser.id,
      free_trial_end_at: daysFromNow(10),
      require_seats: false,
      seat_count: 2,
      plan: 'enterprise',
      auto_top_up_enabled: false,
      settings: {},
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: { free_trial_end_at: daysFromNow(10), plan: 'enterprise' },
    });

  await db
    .insert(organization_memberships)
    .values({ organization_id: EMPTY_ORGANIZATION_ID, kilo_user_id: testUser.id, role: 'owner' })
    .onConflictDoNothing();
  await db
    .insert(organization_memberships)
    .values([
      { organization_id: MEMBER_ORGANIZATION_ID, kilo_user_id: otherUser.id, role: 'owner' },
      { organization_id: MEMBER_ORGANIZATION_ID, kilo_user_id: testUser.id, role: 'member' },
    ])
    .onConflictDoNothing();

  console.log('This fixture represents:');
  console.log('  One enterprise organization with no rows, so every organization list is empty,');
  console.log('  and one enterprise organization where the test account is a plain member, so');
  console.log('  the role-gated screens show their permission-denied copy.');
  console.log('Suggested next step:');
  console.log('  Open a hub link first (it selects the organization), then the screen link.');

  return {
    testUserId: testUser.id,
    testEmail: testUser.email,
    otherOwnerUserId: otherUser.id,
    otherOwnerEmail: otherUser.email,
    emptyOrganizationId: EMPTY_ORGANIZATION_ID,
    emptyOrganizationHubDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${EMPTY_ORGANIZATION_ID}`,
    memberOrganizationId: MEMBER_ORGANIZATION_ID,
    memberOrganizationHubDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${MEMBER_ORGANIZATION_ID}`,
  };
}
