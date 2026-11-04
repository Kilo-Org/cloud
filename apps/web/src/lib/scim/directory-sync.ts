import {
  kilocode_users,
  organization_membership_removals,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  addUserToOrganization,
  createOrganization,
  markOrganizationAsDeleted,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';

import { createChildOrganization } from '@/lib/organizations/organization-hierarchy';
import { removeUserFromOrganization } from '@/lib/organizations/organization-member-removal';
import { createOrUpdateUser, findUserByNormalizedEmail } from '@/lib/user';

import type {
  DirectoryMembership,
  DirectoryMembershipRemovalResult,
  DirectoryMembershipResult,
  DirectoryOrganizationUpsert,
  DirectorySubOrganizationUpsert,
  DirectorySyncDeleteResult,
  DirectorySyncUpsertResult,
  DirectoryUserUpsert,
} from './directory-sync-contracts';

/**
 * Directory-sync mutations, invoked by the `scim-sync` Worker.
 *
 * Every function here is idempotent on a WorkOS identifier and delegates the
 * actual write to the same primitive the product uses, so the advisory locks,
 * depth validation, soft-delete side effects, Stripe customer creation, and
 * removal tombstone all behave identically to a human performing the action.
 */

/** Rows are matched among live organizations only. The directory and external
 * id unique indexes are partial on `deleted_at IS NULL`, so a soft-deleted
 * organization can hold the same binding as a live one. */
const liveOrganization = isNull(organizations.deleted_at);

/**
 * The organization a directory belongs to is the unparented row carrying its
 * `directory_id`. The filter is load-bearing: a sub-organization inherits its
 * parent's `directory_id` as well, so once a group exists the directory matches
 * two live rows, and an unordered `limit(1)` would resolve to whichever the
 * planner returned — PostgreSQL gives no row order without `ORDER BY`, and an
 * update rewriting the parent's tuple is enough to move it behind the child.
 */
function directoryOwner(directoryId: string): SQL | undefined {
  return and(
    eq(organizations.directory_id, directoryId),
    isNull(organizations.parent_organization_id),
    liveOrganization
  );
}

export class DirectorySyncConflictError extends Error {}

/**
 * Bind a WorkOS directory to a parent organization.
 *
 * Matches an existing organization by `external_org_id`, which is how a
 * customer-created organization is adopted by directory sync, and otherwise
 * creates one. Creating with no `userId` means no owner membership is written:
 * a directory has no Kilo actor to credit, and members arrive through
 * `dsync.group.user_added`.
 */
export async function upsertDirectoryOrganization(
  directoryId: string,
  input: DirectoryOrganizationUpsert
): Promise<DirectorySyncUpsertResult> {
  const alreadyBound = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(directoryOwner(directoryId))
    .limit(1);

  const bound = alreadyBound.at(0);
  if (bound) {
    return { id: bound.id, created: false };
  }

  const byExternalId = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.external_org_id, input.workOSOrganizationId), liveOrganization))
    .limit(1);

  const existing = byExternalId.at(0);
  if (existing) {
    await db
      .update(organizations)
      .set({ directory_id: directoryId })
      .where(eq(organizations.id, existing.id));
    return { id: existing.id, created: false };
  }

  // `createOrganization` owns its own transaction and takes no outer one, so
  // create and bind cannot be atomic. `external_org_id` is written first and
  // alone: it is unique among live rows, so a crash before `directory_id` lands
  // leaves a row the lookup above finds on replay and adopts, rather than an
  // invisible orphan that would be duplicated. `directory_id` is not unique and
  // could not provide that guarantee.
  const created = await createOrganization(input.name, null, false);
  await db
    .update(organizations)
    .set({ external_org_id: input.workOSOrganizationId })
    .where(eq(organizations.id, created.id));
  await db
    .update(organizations)
    .set({ directory_id: directoryId })
    .where(eq(organizations.id, created.id));

  return { id: created.id, created: true };
}

/**
 * Bind a WorkOS directory group to a sub-organization under the directory's
 * organization.
 *
 * A directory group maps to a sub-organization, not to Kilo's
 * `organization_groups` table — that holds model-access policies and is
 * unrelated to directory sync.
 */
export async function upsertDirectorySubOrganization(
  directoryGroupId: string,
  input: DirectorySubOrganizationUpsert
): Promise<DirectorySyncUpsertResult> {
  const parentRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(directoryOwner(input.directoryId))
    .limit(1);

  const parent = parentRows.at(0);
  if (!parent) {
    // The hierarchy is one level deep, so a group cannot nest under a group.
    // A directory whose only live row is parented is that case, and it reads
    // differently from a directory with no organization at all, so the Worker
    // gets told which one it hit.
    const parentedRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.directory_id, input.directoryId), liveOrganization))
      .limit(1);
    const parented = parentedRows.at(0);
    throw new DirectorySyncConflictError(
      parented
        ? `Organization ${parented.id} is itself a sub-organization and cannot take children`
        : `No live organization is bound to directory ${input.directoryId}`
    );
  }

  const existingRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.directory_group_id, directoryGroupId), liveOrganization))
    .limit(1);

  const existing = existingRows.at(0);
  if (existing) {
    // Groups get renamed and reconnected, so name and IdP id are refreshed.
    await db
      .update(organizations)
      .set({
        name: input.name,
        directory_id: input.directoryId,
        directory_idp_id: input.directoryIdpId,
        parent_organization_id: parent.id,
      })
      .where(eq(organizations.id, existing.id));
    return { id: existing.id, created: false };
  }

  // One statement, so the row is either unbound or fully bound.
  // `directory_group_id` is unique among live rows, so a crash before it lands
  // leaves an unbound child that this lookup misses — the replay creates a
  // second child rather than adopting it. That is visible as a duplicate
  // sub-organization under the parent rather than silent data loss, and the
  // group lookups keyed on `directory_group_id` stay deterministic.
  const child = await createChildOrganization(input.name, parent.id);
  await db
    .update(organizations)
    .set({
      directory_id: input.directoryId,
      directory_group_id: directoryGroupId,
      directory_idp_id: input.directoryIdpId,
    })
    .where(eq(organizations.id, child.id));

  return { id: child.id, created: true };
}

/**
 * Bind a WorkOS directory user to a Kilo user.
 *
 * Matches `external_id` first, then the normalized email so a directory user
 * who already signed in is adopted rather than duplicated. Creation goes
 * through `createOrUpdateUser`, which owns the Stripe customer, the
 * normalized-email dedup check, the soft-delete fence, and the compensating
 * Stripe delete when any of those reject.
 */
export async function upsertDirectoryUser(
  externalId: string,
  input: DirectoryUserUpsert
): Promise<DirectorySyncUpsertResult> {
  const byExternalId = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.external_id, externalId))
    .limit(1);

  const bound = byExternalId.at(0);
  if (bound) {
    return { id: bound.id, created: false };
  }

  const displayName = [input.firstName, input.lastName].filter(Boolean).join(' ').trim();

  // `findUserByNormalizedEmail` also matches legacy rows whose
  // `normalized_email` is null by comparing `google_user_email`, which a plain
  // equality check on the normalized column would miss.
  const existing = await findUserByNormalizedEmail(input.email);
  if (existing) {
    await db
      .update(kilocode_users)
      .set({ external_id: externalId })
      .where(eq(kilocode_users.id, existing.id));
    return { id: existing.id, created: false };
  }

  const result = await createOrUpdateUser(
    {
      google_user_email: input.email,
      google_user_name: displayName === '' ? input.email : displayName,
      google_user_image_url: '',
      hosted_domain: null,
      // `workos` is the provider SSO sign-in records, so a later sign-in
      // recognizes this account instead of creating a second one.
      provider: 'workos',
      provider_account_id: input.idpId,
    },
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // No end user and no client IP: Bouncer admission cannot run here and does
    // not apply. The caller is authenticated with `INTERNAL_API_SECRET` and the
    // directory was connected by an administrator.
    { skipSignupAdmission: true }
  );

  if (!result.success) {
    // `EMAIL-ALREADY-USED` is the one failure here that no arrival order and no
    // retry can clear: a pre-existing Kilo account holds that address, and
    // `findUserByNormalizedEmail` above already adopted every account this code
    // is willing to claim.
    //
    // It should not stay a refusal. Where the address's domain equals the
    // Effective SSO policy domain of the directory's organization, the
    // enterprise's claim to it is already established by domain capture and the
    // identity provider has asserted that this person holds it, so the existing
    // account must be convertible to the SSO authority's WorkOS identity and
    // bound to this Directory user instead — see `.specs/organization-sso.md`,
    // Directory Sync rule 13. That conversion is not implemented here yet: it
    // needs the SSO policy lookup, session invalidation under Authentication
    // rule 7, and an audit record. A non-matching domain stays refused.
    throw new DirectorySyncConflictError(`Could not provision directory user: ${result.error}`);
  }

  await db
    .update(kilocode_users)
    .set({ external_id: externalId })
    .where(eq(kilocode_users.id, result.user.id));

  return { id: result.user.id, created: result.isNew };
}

/**
 * Add a directory user to the sub-organization its group maps to, and to that
 * sub-organization's parent.
 *
 * Membership in the parent is what grants access to the directory's
 * organization at all; the sub-organization membership is the group itself.
 *
 * A removal tombstone is cleared rather than respected. For a
 * directory-managed organization the identity provider is authoritative, so an
 * earlier Kilo-side removal does not outlive the directory's view. The result
 * reports when this happened, because it reverses a deliberate action.
 */
export async function addDirectoryMembership(
  input: DirectoryMembership
): Promise<DirectoryMembershipResult> {
  const groupRows = await db
    .select({ id: organizations.id, parent: organizations.parent_organization_id })
    .from(organizations)
    .where(and(eq(organizations.directory_group_id, input.directoryGroupId), liveOrganization))
    .limit(1);

  const group = groupRows.at(0);
  if (!group) {
    throw new DirectorySyncConflictError(
      `No live sub-organization is bound to directory group ${input.directoryGroupId}`
    );
  }

  const userRows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.external_id, input.externalId))
    .limit(1);

  const user = userRows.at(0);
  if (!user) {
    throw new DirectorySyncConflictError(`No user is bound to directory user ${input.externalId}`);
  }

  const targets = group.parent === null ? [group.id] : [group.parent, group.id];

  const cleared = await db
    .delete(organization_membership_removals)
    .where(
      and(
        inArray(organization_membership_removals.organization_id, targets),
        eq(organization_membership_removals.kilo_user_id, user.id)
      )
    );

  let created = false;
  for (const organizationId of targets) {
    const added = await addUserToOrganization(organizationId, user.id, 'member');
    created = created || added;
  }

  return {
    organizationId: group.id,
    parentOrganizationId: group.parent,
    kiloUserId: user.id,
    created,
    clearedRemovalTombstone: (cleared.rowCount ?? 0) > 0,
  };
}

/**
 * Remove a directory user from the sub-organization its group maps to.
 *
 * Only the sub-organization: the user may belong to sibling groups under the
 * same parent, so leaving one group must not revoke access to the directory's
 * organization.
 *
 * Converges rather than conflicting. An unknown group or user means there is no
 * membership to revoke, which is the state the event asks for, so it reports
 * `removed: false` instead of throwing. The alternative would be provisioning
 * the group and user first — which creates a Kilo account for a user who is
 * leaving the directory — or holding the Worker's cursor on a 409 waiting for
 * an add that may never arrive.
 *
 * `removeUserFromOrganization` hard-deletes the membership and writes the
 * tombstone, which is the repo's removal protocol, and also cascades away the
 * user's model-access group assignments in that organization.
 */
export async function removeDirectoryMembership(
  input: DirectoryMembership
): Promise<DirectoryMembershipRemovalResult> {
  const groupRows = await db
    .select({ id: organizations.id, parent: organizations.parent_organization_id })
    .from(organizations)
    .where(and(eq(organizations.directory_group_id, input.directoryGroupId), liveOrganization))
    .limit(1);

  const group = groupRows.at(0);
  if (!group) {
    return {
      organizationId: null,
      parentOrganizationId: null,
      kiloUserId: null,
      removed: false,
    };
  }

  const userRows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.external_id, input.externalId))
    .limit(1);

  const user = userRows.at(0);
  if (!user) {
    return {
      organizationId: group.id,
      parentOrganizationId: group.parent,
      kiloUserId: null,
      removed: false,
    };
  }

  // `removedBy` is left undefined: the actor is the identity provider, and the
  // column holds a Kilo user id, so there is no honest value. The helper falls
  // back to the removed user's own id for the group-policy revision bump, and
  // the tombstone records `removed_by` as null — which is what "not removed by
  // a Kilo user" should look like.
  const { rowCount } = await removeUserFromOrganization(group.id, user.id);

  return {
    organizationId: group.id,
    parentOrganizationId: group.parent,
    kiloUserId: user.id,
    // A replayed removal finds no membership and reports no change, which is
    // what makes the route idempotent.
    removed: (rowCount ?? 0) > 0,
  };
}

/**
 * Soft-delete the parent organization bound to a directory, and every
 * sub-organization under it.
 *
 * The match is restricted to the unparented row, through `directoryOwner`: a
 * sub-organization carries its parent's `directory_id` too, so matching on that
 * column alone could soft-delete a group while leaving the organization live.
 *
 * Children go with the parent. Leaving them live would strand
 * sub-organizations whose parent is deleted, and their directory group bindings
 * would keep matching group events for a directory that no longer exists.
 */
export async function deleteDirectoryOrganization(
  directoryId: string
): Promise<DirectorySyncDeleteResult> {
  const result = await softDeleteBoundOrganization(directoryOwner(directoryId));
  if (!result.deleted) return result;

  const children = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.parent_organization_id, result.id), liveOrganization));

  for (const child of children) {
    await markOrganizationAsDeleted(child.id);
  }

  return result;
}

/** Soft-delete the sub-organization bound to a directory group. */
export async function deleteDirectorySubOrganization(
  directoryGroupId: string
): Promise<DirectorySyncDeleteResult> {
  return softDeleteBoundOrganization(eq(organizations.directory_group_id, directoryGroupId));
}

async function softDeleteBoundOrganization(
  match: SQL | undefined
): Promise<DirectorySyncDeleteResult> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(match, liveOrganization))
    .limit(1);

  const target = rows.at(0);
  // No live row is the idempotent repeat: a replayed deletion is a no-op.
  if (!target) {
    return { id: '', deleted: false };
  }

  await markOrganizationAsDeleted(target.id);
  return { id: target.id, deleted: true };
}
