import { z } from 'zod';

/**
 * The app's side of the internal directory-sync endpoints, as this Worker sees
 * it.
 *
 * Mirrors `apps/web/src/lib/scim/directory-sync-contracts.ts`. The duplication
 * is deliberate: the app is a separate deployment reached over HTTP, so its
 * types are not something this Worker can import.
 *
 * Request bodies are types rather than schemas — this Worker constructs them,
 * and the app's are `z.strictObject`, so a field invented here is a 400 there
 * rather than a silently dropped one. Responses are schemas, because they cross
 * an IO boundary into here and are parsed rather than cast.
 */

export type DirectoryOrganizationUpsert = {
  /** `data.organizationId`. */
  workOSOrganizationId: string;
  name: string;
  /** `data.domains[].domain`. Absent says nothing; it never clears. */
  capturedDomains?: string[];
};

export type DirectorySubOrganizationUpsert = {
  directoryId: string;
  /** `data.idpId` — survives a disconnect/reconnect that mints a new group id. */
  directoryIdpId: string;
  name: string;
};

export type DirectoryUserUpsert = {
  directoryId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
};

/** A membership is identified by a pair, so it travels in the body. */
export type DirectoryMembership = {
  directoryGroupId: string;
  externalId: string;
};

export const DirectorySyncUpsertResultSchema = z.object({
  id: z.string(),
  created: z.boolean(),
});

export const DirectorySyncDeleteResultSchema = z.object({
  id: z.string(),
  deleted: z.boolean(),
});

export const DirectoryMembershipResultSchema = z.object({
  organizationId: z.string(),
  parentOrganizationId: z.string().nullable(),
  kiloUserId: z.string(),
  created: z.boolean(),
  clearedRemovalTombstone: z.boolean(),
});

export const DirectoryMembershipRemovalResultSchema = z.object({
  organizationId: z.string().nullable(),
  parentOrganizationId: z.string().nullable(),
  kiloUserId: z.string().nullable(),
  removed: z.boolean(),
  revokedParentMembership: z.boolean(),
});

export const DirectoryMembershipRevokeAllResultSchema = z.object({
  kiloUserId: z.string().nullable(),
  revokedOrganizationIds: z.array(z.string()),
});

/**
 * The conflict body: `{ error, code }`. The code is what decides whether the
 * cursor waits for a dependency or the event is parked, so it is read from the
 * body rather than inferred from the message.
 *
 * `code` is a plain string rather than an enum so that a code this Worker does
 * not know is still a parsed conflict. An unknown code is treated as
 * retryable, which is the direction that cannot lose an event: the retry
 * budget turns a persistently unsatisfiable one into a park an hour later.
 */
export const ConflictBodySchema = z.object({
  error: z.string(),
  code: z.string(),
});

/**
 * Conflict codes that no arrival order and no amount of waiting repairs: a
 * structural hierarchy violation, a claim the directory cannot substantiate,
 * and two bindings that would have to be broken to proceed. Every other code,
 * and every unrecognized one, is retryable.
 */
export const TERMINAL_CONFLICT_CODES: Record<string, true> = {
  sub_organization_cannot_nest: true,
  domain_not_captured: true,
  account_bound_to_other_directory_user: true,
  address_held_by_another_account: true,
};
