import { randomUUID } from 'node:crypto';

import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export const usage = '<owner-email> <member-email>';

/**
 * Two organizations the same fake owner belongs to, one per role-change outcome
 * the mobile member row has to explain:
 *
 * - `refusedOrganizationId` never got a seat subscription and its trial ended
 *   more than three days ago, so `classifyOrganizationEntitlement` reports
 *   `trial_expired_hard` with no bypass and every organization mutation is
 *   refused with `FORBIDDEN` / `Organization trial has expired.` The owner and
 *   one active member belong to it, so a role change picked from the member
 *   row's role chooser is rejected by the server.
 * - `acceptedOrganizationId` is a fresh organization inside its trial with the
 *   same two memberships, so the same role change succeeds.
 */
const REFUSED_ORGANIZATION_ID = '5c1e7a90-0000-4000-8000-6a7b8c9d0e21';
const ACCEPTED_ORGANIZATION_ID = '5c1e7a90-0000-4000-8000-6a7b8c9d0e22';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-org-members ${usage}`);
  console.log(
    'Seeds a local-only fake owner and member with one organization whose trial ended and one inside its trial.'
  );
  console.log('Requires a localhost database and SKIP_STRIPE_API=true; never calls a provider.');
  console.log('Open the returned deep links in the signed-in mobile development client.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [ownerEmail, memberEmail, ...extra] = args;
  const fakeEmail = /^kilo-[a-z0-9-]+@example\.com$/;
  if (
    !ownerEmail ||
    !memberEmail ||
    extra.length ||
    ![ownerEmail, memberEmail].every(email => fakeEmail.test(email))
  ) {
    printUsage();
    throw new Error('Pass two distinct fake emails: owner and member.');
  }
  if (ownerEmail === memberEmail) {
    throw new Error('Pass two distinct fake emails: owner and member.');
  }
  assertLocalSeedDatabase('app:mobile-org-members');
  if (process.env.NODE_ENV === 'production' || process.env.SKIP_STRIPE_API !== 'true') {
    throw new Error('This fixture requires a local development database and SKIP_STRIPE_API=true.');
  }
  const db = getSeedDb();
  const people = [
    { email: ownerEmail, name: 'Members lab owner', role: 'owner' as const },
    { email: memberEmail, name: 'Members lab member', role: 'member' as const },
  ];
  const userIds: Record<'owner' | 'member', string> = {
    owner: '',
    member: '',
  } as never;
  for (const person of people) {
    const userId = `dev-seed:mobile-org-members:${person.email}`;
    const [existing] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.normalized_email, person.email));
    if (existing && existing.id !== userId) {
      throw new Error(`${person.email} belongs to a different account; choose a new fake email.`);
    }
    await db
      .insert(kilocode_users)
      .values({
        id: userId,
        google_user_email: person.email,
        normalized_email: person.email,
        google_user_name: person.name,
        google_user_image_url: '',
        stripe_customer_id: `cus_local_org_members_${randomUUID()}`,
        has_validation_stytch: false,
        customer_source: 'dev-seed',
      })
      .onConflictDoNothing();
    userIds[person.role] = userId;
  }

  await db
    .insert(organizations)
    .values({
      id: REFUSED_ORGANIZATION_ID,
      name: 'Members lab refused',
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      created_by_kilo_user_id: userIds.owner,
      stripe_customer_id: `cus_local_org_members_${randomUUID()}`,
      free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      require_seats: true,
      plan: 'teams',
      settings: {},
    })
    .onConflictDoNothing();
  await db
    .insert(organizations)
    .values({
      id: ACCEPTED_ORGANIZATION_ID,
      name: 'Members lab accepted',
      created_by_kilo_user_id: userIds.owner,
      stripe_customer_id: `cus_local_org_members_${randomUUID()}`,
      require_seats: true,
      plan: 'teams',
      settings: {},
    })
    .onConflictDoNothing();
  for (const organizationId of [REFUSED_ORGANIZATION_ID, ACCEPTED_ORGANIZATION_ID]) {
    for (const person of people) {
      await db
        .insert(organization_memberships)
        .values({
          organization_id: organizationId,
          kilo_user_id: userIds[person.role],
          role: person.role,
        })
        .onConflictDoNothing();
    }
  }

  console.log('This fixture represents: an owner changing another member\u2019s role.');
  console.log('The refused organization answers the role change with the trial sentence.');
  console.log('Suggested next step: open a returned deep link on the signed-in mobile app.');
  return {
    ownerUserId: userIds.owner,
    memberUserId: userIds.member,
    ownerEmail,
    memberEmail,
    refusedOrganizationId: REFUSED_ORGANIZATION_ID,
    refusedOrganizationName: 'Members lab refused',
    acceptedOrganizationId: ACCEPTED_ORGANIZATION_ID,
    acceptedOrganizationName: 'Members lab accepted',
    membersDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${REFUSED_ORGANIZATION_ID}/members`,
    acceptedMembersDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${ACCEPTED_ORGANIZATION_ID}/members`,
  };
}
