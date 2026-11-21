import 'server-only';
import { and, asc, eq, ilike, isNull, ne, notLike, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { escapeLikePattern } from '@/lib/sql-like';

export const ORGANIZATION_MEMBER_SEARCH_LIMIT = 10;

export const OrganizationMemberSearchQuerySchema = z.string().trim().min(2).max(100);

/**
 * What a member search reveals about a person. Email, role, usage and
 * invitations never leave this module: the caller may be any member, or a
 * Pages deployment acting for one.
 */
export type OrganizationMemberMatch = {
  id: string;
  name: string;
  image_url: string | null;
};

export type OrganizationMemberLookup = { query: string } | { memberId: string };

const isActivePerson = and(
  eq(kilocode_users.is_bot, false),
  isNull(kilocode_users.blocked_at),
  isNull(kilocode_users.blocked_reason)
);

/**
 * Directory sync stores the email as the name when the directory has none, and
 * several sign-ins store an empty name. A name with an `@` (ASCII or full
 * width) is never matched or returned, so a query can never confirm an address.
 */
const hasSearchableName = and(
  ne(sql`btrim(${kilocode_users.google_user_name})`, ''),
  notLike(kilocode_users.google_user_name, '%@%'),
  notLike(kilocode_users.google_user_name, '%＠%')
);

/** Case-insensitive prefix on any space-separated word of the name. */
function nameHasWordStartingWith(query: string): SQL | undefined {
  const prefix = escapeLikePattern(query);
  return or(
    ilike(kilocode_users.google_user_name, `${prefix}%`),
    ilike(kilocode_users.google_user_name, `% ${prefix}%`)
  );
}

/**
 * Whether `userId` may search `organizationId`: the account exists, is not
 * blocked, and holds its own membership row in a live organization.
 *
 * Deliberately stricter than `organizationMemberProcedure`: a Kilo admin, or an
 * owner of a parent organization, gets no search through elevation.
 */
async function isDirectMember(userId: string, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId),
        isNull(kilocode_users.blocked_at),
        isNull(kilocode_users.blocked_reason),
        isNull(organizations.deleted_at)
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Active direct members of `organizationId` matching `lookup`, at most
 * {@link ORGANIZATION_MEMBER_SEARCH_LIMIT}, or null when `searcherId` may not
 * search it. A `query` must already satisfy
 * {@link OrganizationMemberSearchQuerySchema}. A `memberId` lookup answers with
 * that one person or nobody, under the same filters as a search, so a
 * person who never shows up in a search can't be resolved either.
 */
export async function findOrganizationMembers(
  searcherId: string,
  organizationId: string,
  lookup: OrganizationMemberLookup
): Promise<OrganizationMemberMatch[] | null> {
  if (!(await isDirectMember(searcherId, organizationId))) return null;

  const matches =
    'query' in lookup
      ? nameHasWordStartingWith(lookup.query)
      : eq(kilocode_users.id, lookup.memberId);

  const rows = await db
    .select({
      id: kilocode_users.id,
      name: kilocode_users.google_user_name,
      image_url: kilocode_users.google_user_image_url,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        isActivePerson,
        hasSearchableName,
        matches
      )
    )
    .orderBy(asc(kilocode_users.google_user_name), asc(kilocode_users.id))
    .limit(ORGANIZATION_MEMBER_SEARCH_LIMIT);

  return rows.map(row => ({ ...row, image_url: row.image_url === '' ? null : row.image_url }));
}
