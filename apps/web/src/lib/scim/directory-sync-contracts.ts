import { z } from 'zod';

/**
 * Request and response contracts for the internal directory-sync endpoints.
 *
 * The `scim-sync` Worker polls the WorkOS Events API and calls these routes for
 * every mutation instead of writing to PostgreSQL itself. Organization, user,
 * and membership writes carry rules that already live here — advisory locks, the
 * sub-organization depth check, the soft-delete side effects, Stripe customer
 * creation, the normalized-email dedup and deletion fences, and the membership
 * removal tombstone — so the Worker reuses them rather than reimplementing
 * them against raw tables.
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
  /** `data.email`. Required: a user row cannot exist without one. */
  email: z.string().email().max(320),
  firstName: z.string().max(255).nullish(),
  lastName: z.string().max(255).nullish(),
  /** `data.idp_id` — recorded as the `workos` auth provider account id. */
  idpId: workOSId,
});

export type DirectoryUserUpsert = z.infer<typeof DirectoryUserUpsertSchema>;

export const DirectoryMembershipSchema = z.strictObject({
  /** Identifies the sub-organization; its parent is resolved from the row. */
  directoryGroupId: workOSId,
  /** `kilocode_users.external_id` of an already-provisioned directory user. */
  externalId: workOSId,
});

export type DirectoryMembership = z.infer<typeof DirectoryMembershipSchema>;

/** Returned by every upsert so the caller can log what changed. */
export type DirectorySyncUpsertResult = {
  /** Kilo's identifier for the affected row. */
  id: string;
  /** False when an existing row was matched and updated. */
  created: boolean;
};

export type DirectoryMembershipResult = {
  organizationId: string;
  parentOrganizationId: string | null;
  kiloUserId: string;
  /** False when the membership already existed. */
  created: boolean;
  /**
   * True when a removal tombstone was cleared to admit this member. The
   * directory is authoritative for directory-managed organizations, so an
   * earlier Kilo-side removal does not outlive the identity provider's view —
   * but it is worth surfacing, because it means a deliberate removal was
   * reversed.
   */
  clearedRemovalTombstone: boolean;
};

/** Soft delete: `deleted_at` is stamped, nothing is removed. */
export type DirectorySyncDeleteResult = {
  id: string;
  /** False when no live row matched, which is the idempotent repeat case. */
  deleted: boolean;
};
