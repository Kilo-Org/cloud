import { z } from 'zod';

/**
 * Request and response contracts for the internal directory-sync endpoints.
 *
 * Shared on purpose. `apps/web` serves these endpoints and the `scim-sync`
 * Worker calls them, they deploy independently, and the request schemas are
 * strict — so a field one side invents is a 400 that stalls the Worker's
 * cursor rather than a dropped key. A mirrored copy per side would make that
 * drift silent until a directory event hit it; one module makes it a
 * compile error.
 *
 * The Worker calls these routes for every mutation instead of writing to
 * PostgreSQL itself. Organization, user, and membership writes carry rules
 * that live in the app — advisory locks, the sub-organization depth check,
 * the soft-delete side effects, Stripe customer creation, the
 * normalized-email dedup and deletion fences, and the membership removal
 * tombstone — so the Worker reuses them rather than reimplementing them
 * against raw tables.
 *
 * Every route is keyed on a WorkOS identifier and is an idempotent upsert, so
 * replaying an event is a no-op. That matters: the Worker commits its cursor per
 * event, and a crash mid-page replays the last one.
 */

/** A WorkOS identifier. Opaque to us; only non-emptiness is ours to check. */
const workOSId = z.string().min(1).max(255);

/**
 * Request schemas are strict: an unknown field is a mismatch between the Worker
 * and this app, and dropping it silently would mean silently wrong directory
 * data — a renamed field would stop applying rather than fail. Because the two
 * deploy independently, a new field must land here as optional before the
 * Worker starts sending it, or every event 400s and the cursor stalls.
 */

export const DirectoryOrganizationUpsertSchema = z.strictObject({
  /** `data.organization_id` — matched against `organizations.external_org_id`. */
  workOSOrganizationId: workOSId,
  /** `data.name` — used only when creating. */
  name: z.string().min(1).max(255),
  /**
   * `data.domains[].domain` — the domains the organization has captured in
   * WorkOS, which our administrators gate on intake. The first one that is not
   * already claimed by another organization becomes the organization's
   * `sso_domain`, which is what authorizes taking over an existing account on
   * that domain.
   *
   * Optional, and an empty list is normal: a directory can exist before a
   * domain is attached, and `dsync.deleted` omits `domains` entirely. Absent
   * means "say nothing about domains", never "clear them" — releasing an SSO
   * domain stays a deliberate administrative action.
   */
  capturedDomains: z.array(z.string().min(1).max(255)).max(50).optional(),
});

export type DirectoryOrganizationUpsert = z.infer<typeof DirectoryOrganizationUpsertSchema>;

export const DirectorySubOrganizationUpsertSchema = z.strictObject({
  /** `data.directory_id` — resolves the parent organization. */
  directoryId: workOSId,
  /** `data.idp_id` — survives a disconnect/reconnect that mints a new group id. */
  directoryIdpId: workOSId,
  /** `data.name`. Applied on update as well as create: groups get renamed. */
  name: z.string().min(1).max(255),
});

export type DirectorySubOrganizationUpsert = z.infer<typeof DirectorySubOrganizationUpsertSchema>;

export const DirectoryUserUpsertSchema = z.strictObject({
  /**
   * `data.directory_id` — resolves the organization whose Effective SSO policy
   * domain decides whether a pre-existing account holding this address may be
   * taken over. Required: without it the domain gate cannot run.
   */
  directoryId: workOSId,
  /** `data.email`. Required: a user row cannot exist without one. */
  email: z.string().email().max(320),
  firstName: z.string().max(255).nullish(),
  lastName: z.string().max(255).nullish(),
  // No `idp_id`. The `workos` auth provider row is keyed on the directory user
  // id from the path, because `idp_id` is assigned by the customer's identity
  // provider and is not unique across directories; keying on it let one
  // directory user resolve to another person's account.
});

export type DirectoryUserUpsert = z.infer<typeof DirectoryUserUpsertSchema>;

export const DirectoryMembershipSchema = z.strictObject({
  /** Identifies the sub-organization; its parent is resolved from the row. */
  directoryGroupId: workOSId,
  /** `kilocode_users.external_id` of an already-provisioned directory user. */
  externalId: workOSId,
});

export type DirectoryMembership = z.infer<typeof DirectoryMembershipSchema>;

/**
 * Machine-readable reason a directory-sync write was refused, returned in the
 * 409 body as `code` alongside the human-readable `error`.
 *
 * The distinction the consumer needs is not which rule refused, but whether
 * waiting can clear it. A missing dependency is an arrival-order problem: the
 * event that would create it may still be behind the cursor, so the Worker
 * holds its cursor and retries. A refusal is a statement about the directory's
 * own configuration or about a conflict with state the directory does not own,
 * and no amount of retrying changes it — the Worker parks the event with the
 * reason recorded rather than stalling every tenant behind one.
 *
 * See `.specs/organization-sso.md`, Directory Sync rules 7 and 20.
 */
export type DirectorySyncConflictCode =
  /**
   * Sub-organization upsert: no live organization is bound to the directory.
   * Retryable — `dsync.activated` may not have been applied yet.
   */
  | 'directory_not_found'
  /**
   * Sub-organization upsert: the directory's live organization is itself
   * parented, and the hierarchy is one level deep. Terminal — nothing the
   * directory can send repairs it; an operator must reparent.
   */
  | 'sub_organization_cannot_nest'
  /**
   * Membership add: no live sub-organization is bound to the directory group.
   * Retryable — the group's create event may still be behind the cursor.
   */
  | 'sub_organization_not_found'
  /**
   * Membership add: no Kilo account is bound to the directory user. Retryable
   * — the user's create event may still be behind the cursor.
   */
  | 'user_not_found'
  /**
   * User upsert: account provisioning was rejected, by the normalized-email
   * dedup, the deletion fence, or billing-customer creation. Retryable — a
   * transient rejection clears, and a persistent one is reported each time.
   */
  | 'user_provisioning_failed'
  /**
   * User upsert: an existing account holds the address, and the directory's
   * organization has not captured its domain, or its SSO policy fails closed.
   * Terminal — only an administrator capturing the domain clears it.
   */
  | 'domain_not_captured'
  /**
   * User upsert: the account for this address already carries a different
   * directory user identifier, and one account binds to at most one directory
   * user. Terminal — the directory must stop asserting the duplicate.
   */
  | 'account_bound_to_other_directory_user'
  /**
   * User update: the directory moved the user onto an address another Kilo
   * account already holds. Terminal — resolving it means changing one of the
   * two accounts, which directory sync will not do on its own.
   */
  | 'address_held_by_another_account';

/**
 * Codes no arrival order and no amount of waiting repairs: a structural
 * hierarchy violation, a claim the directory cannot substantiate, and two
 * bindings that would have to be broken to proceed. The consumer parks these
 * on the first attempt. Every other code is retryable, because an event
 * *behind* the cursor can still supply what is missing.
 *
 * Lives beside the union rather than in the consumer, so adding a code is one
 * decision in one place: a new member that nobody classified fails the
 * exhaustive `Record` here instead of silently defaulting to retryable in a
 * Worker whose copy was never updated.
 */
export const TERMINAL_CONFLICT_CODES: Record<DirectorySyncConflictCode, boolean> = {
  directory_not_found: false,
  sub_organization_cannot_nest: true,
  sub_organization_not_found: false,
  user_not_found: false,
  user_provisioning_failed: false,
  domain_not_captured: true,
  account_bound_to_other_directory_user: true,
  address_held_by_another_account: true,
};

/**
 * The 409 body. `code` is a plain string rather than the union, because a code
 * the reader does not know must still parse: an unrecognized one is treated as
 * retryable, which is the direction that cannot lose an event.
 */
export const DirectorySyncConflictBodySchema = z.object({
  error: z.string(),
  code: z.string(),
});

/** Whether a conflict code is one waiting cannot clear. Unknown is retryable. */
export function isTerminalConflictCode(code: string): boolean {
  return TERMINAL_CONFLICT_CODES[code as DirectorySyncConflictCode] === true;
}

/**
 * Response shapes are schemas, not bare types, because the Worker parses them
 * on the way back in: a 2xx whose body is not the contract means the two
 * deployments disagree, and a cast would hide that until the parsed value was
 * used. The app's route handlers are typed by the inferred type, so one
 * definition serves both directions.
 */

/** Returned by every upsert so the caller can log what changed. */
export const DirectorySyncUpsertResultSchema = z.object({
  /** Kilo's identifier for the affected row. */
  id: z.string(),
  /** False when an existing row was matched and updated. */
  created: z.boolean(),
});

export type DirectorySyncUpsertResult = z.infer<typeof DirectorySyncUpsertResultSchema>;

export const DirectoryMembershipResultSchema = z.object({
  organizationId: z.string(),
  parentOrganizationId: z.string().nullable(),
  kiloUserId: z.string(),
  /** False when the membership already existed. */
  created: z.boolean(),
  /**
   * True when a removal tombstone was cleared to admit this member. The
   * directory is authoritative for directory-managed organizations, so an
   * earlier Kilo-side removal does not outlive the identity provider's view —
   * but it is worth surfacing, because it means a deliberate removal was
   * reversed.
   */
  clearedRemovalTombstone: z.boolean(),
});

export type DirectoryMembershipResult = z.infer<typeof DirectoryMembershipResultSchema>;

/**
 * Removal is reported separately from an add, because it converges rather than
 * requiring its subjects to exist.
 *
 * A `dsync.group.user_removed` for a group or user Kilo never provisioned has
 * nothing to revoke, so it reports `removed: false` with null subjects instead
 * of conflicting. Provisioning them to satisfy the removal would create a Kilo
 * account for a user who is leaving the directory, which is plainly wrong, and
 * a 409 would hold the cursor waiting for an add that may never come.
 *
 * The tradeoff is deliberate: with no membership row there is no tombstone, so
 * a `user_removed` that overtakes its `user_added` lets the late add win. Add
 * before remove is the normal order and WorkOS consumes serially, so this is a
 * rare reordering, and it is preferred over provisioning departing users.
 */
export const DirectoryMembershipRemovalResultSchema = z.object({
  /** Null when no live sub-organization is bound to the directory group. */
  organizationId: z.string().nullable(),
  parentOrganizationId: z.string().nullable(),
  /** Null when no user is bound to the directory user. */
  kiloUserId: z.string().nullable(),
  /** False when there was nothing to remove, which is the converged case. */
  removed: z.boolean(),
  /**
   * True when the parent organization membership was revoked as well, because
   * this was the user's last directory group under it. Group membership is the
   * identity provider's statement that the user belongs to the enterprise, so
   * the enterprise membership does not outlive the last group — otherwise a
   * user removed from every group, or deleted from the directory, keeps access
   * to the organization's seats and data.
   */
  revokedParentMembership: z.boolean(),
});

export type DirectoryMembershipRemovalResult = z.infer<
  typeof DirectoryMembershipRemovalResultSchema
>;

/**
 * Revokes every directory membership the account bound to a directory user
 * holds: the directory group organizations, and their parents under rule 4.
 *
 * Applied for a hard deletion and for an update reporting the user `inactive`.
 * The account itself is never deleted or anonymized (rule 10): the membership
 * rows are the directory's to revoke, the account is not.
 *
 * Converges like the single membership removal: an `externalId` no account is
 * bound to has nothing to revoke, which is the state the event asserts, so it
 * answers with a null user and an empty list rather than conflicting.
 */
export const DirectoryMembershipRevokeAllResultSchema = z.object({
  /** Null when no Kilo account is bound to the directory user: the converged case. */
  kiloUserId: z.string().nullable(),
  /**
   * Organizations a membership row was actually deleted from, groups and
   * parents. Empty on a replay, which is what makes the route idempotent.
   */
  revokedOrganizationIds: z.array(z.string()),
});

export type DirectoryMembershipRevokeAllResult = z.infer<
  typeof DirectoryMembershipRevokeAllResultSchema
>;

/** Soft delete: `deleted_at` is stamped, nothing is removed. */
export const DirectorySyncDeleteResultSchema = z.object({
  id: z.string(),
  /** False when no live row matched, which is the idempotent repeat case. */
  deleted: z.boolean(),
});

export type DirectorySyncDeleteResult = z.infer<typeof DirectorySyncDeleteResultSchema>;
