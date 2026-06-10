/**
 * Helpers to create mock kilocode_users + organization_memberships for the
 * local dev usage data generator.
 *
 * Mock users have a distinctive email pattern (`mock-org-<shortId>-<i>@example.com`)
 * so they are easy to identify and clean up later if needed.
 *
 * The creation flow is collision-safe: if a previous run created
 * `kilocode_users` rows but their memberships were later removed, re-running
 * the script reuses those rows (via email lookup) rather than trying to
 * re-insert them and hitting the unique-email constraint.
 */
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/drizzle';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { hosted_domain_specials } from '@/lib/auth/constants';

export type OrgMember = {
  userId: string;
  email: string;
  name: string;
};

async function fetchMembers(organizationId: string): Promise<OrgMember[]> {
  const rows = await db
    .select({
      userId: organization_memberships.kilo_user_id,
      email: kilocode_users.google_user_email,
      name: kilocode_users.google_user_name,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(eq(organization_memberships.organization_id, organizationId));
  return rows.map(r => ({ userId: r.userId, email: r.email, name: r.name }));
}

/**
 * Look up existing kilocode_users rows by email. Used to reuse rows left
 * behind by a prior run whose memberships were wiped.
 */
async function findUsersByEmails(emails: string[]): Promise<Map<string, OrgMember>> {
  if (emails.length === 0) return new Map();
  const rows = await db
    .select({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
      name: kilocode_users.google_user_name,
    })
    .from(kilocode_users)
    .where(inArray(kilocode_users.google_user_email, emails));
  return new Map(rows.map(r => [r.email, { userId: r.id, email: r.email, name: r.name }]));
}

/**
 * Ensure the organization has at least `targetCount` members. Creates mock
 * users and memberships as needed. Safe to re-run: reuses any existing
 * `kilocode_users` rows matching the mock email pattern rather than
 * colliding on the unique email constraint.
 */
export async function ensureOrgHasAtLeast(
  organizationId: string,
  targetCount: number
): Promise<{ members: OrgMember[]; created: OrgMember[] }> {
  const existing = await fetchMembers(organizationId);
  if (existing.length >= targetCount) {
    return { members: existing, created: [] };
  }

  const shortId = organizationId.replace(/-/g, '').slice(0, 8);
  const targetEmails = Array.from(
    { length: targetCount },
    (_, i) => `mock-org-${shortId}-${i + 1}@example.com`
  );

  const alreadyMemberEmails = new Set(existing.map(e => e.email));
  const candidateEmails = targetEmails.filter(e => !alreadyMemberEmails.has(e));

  const emailsToUse = candidateEmails.slice(0, targetCount - existing.length);

  const existingByEmail = await findUsersByEmails(emailsToUse);
  const rowsToCreate: OrgMember[] = [];
  const toAdd: OrgMember[] = [];

  for (const email of emailsToUse) {
    const index = targetEmails.indexOf(email) + 1;
    const name = `Mock User ${index}`;
    const reused = existingByEmail.get(email);
    if (reused) {
      toAdd.push(reused);
    } else {
      const newMember: OrgMember = { userId: randomUUID(), email, name };
      rowsToCreate.push(newMember);
      toAdd.push(newMember);
    }
  }

  if (rowsToCreate.length > 0) {
    await db.insert(kilocode_users).values(
      rowsToCreate.map(u => ({
        id: u.userId,
        google_user_email: u.email,
        google_user_name: u.name,
        google_user_image_url: '',
        stripe_customer_id: `mock-stripe-${u.userId}`,
        hosted_domain: hosted_domain_specials.non_workspace_google_account,
      }))
    );
  }

  if (toAdd.length > 0) {
    await db
      .insert(organization_memberships)
      .values(
        toAdd.map(u => ({
          organization_id: organizationId,
          kilo_user_id: u.userId,
          role: 'member' as const,
        }))
      )
      .onConflictDoNothing({
        target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
      });
  }

  // Re-fetch to ensure the returned list reflects DB state (covers the case
  // where an earlier membership row existed and onConflictDoNothing skipped).
  const finalMembers = await fetchMembers(organizationId);

  return {
    members: finalMembers,
    created: rowsToCreate,
  };
}
