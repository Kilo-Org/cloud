/**
 * Pure ownership rules for the mobile profile manager.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-owner-model.test.ts`. The rules mirror the web Manage
 * Profiles dialog (`apps/web/src/components/cloud-agent/ProfilesListDialog.tsx`),
 * which is the source of truth for personal versus organization ownership:
 * which owner a create may carry, which `organizationId` an existing profile's
 * read/write must carry, and how the combined list splits into its buckets.
 */

/** The owner a user can pick when creating a profile. */
export type ProfileOwnerChoice = 'personal' | 'organization';

/**
 * The owner tag a profile list item carries. The server tags organization rows
 * `organization` and personal rows `user` (`ProfilesListDialog.tsx:95-98`).
 */
type ProfileOwnerType = 'user' | 'organization';

/** The part of a profile summary ownership depends on. */
type OwnerBearing = { ownerType?: ProfileOwnerType };

/**
 * The owner choices a create screen offers. An organization context offers
 * Personal and Organization; a personal context offers Personal only
 * (`ProfilesListDialog.tsx:431-459`).
 */
export function ownerChoices(
  organizationId: string | null | undefined
): readonly ProfileOwnerChoice[] {
  return hasOrganizationContext(organizationId) ? ['personal', 'organization'] : ['personal'];
}

/** Whether an organization context is active, i.e. ownership is a choice. */
export function hasOrganizationContext(
  organizationId: string | null | undefined
): organizationId is string {
  return organizationId != null;
}

/** The owner choice an existing profile is. An untagged row is personal. */
export function profileOwnerType(profile: OwnerBearing): ProfileOwnerChoice {
  return profile.ownerType === 'organization' ? 'organization' : 'personal';
}

/**
 * The `organizationId` a create must send for the chosen owner. Only an
 * organization-owned profile sends it (`ProfilesListDialog.tsx:173-179`): a
 * personal profile must never inherit the selected organization, or it would
 * be created under the wrong owner.
 */
export function createOrganizationId(
  organizationId: string | null | undefined,
  owner: ProfileOwnerChoice
): string | undefined {
  return hasOrganizationContext(organizationId) && owner === 'organization'
    ? organizationId
    : undefined;
}

/**
 * The `organizationId` an update, delete or detail read must send for an
 * existing profile: the active context id only when the profile is
 * organization-owned, and `undefined` for a personal profile even inside an
 * organization context (`ProfilesListDialog.tsx:142-156,308-319`).
 */
export function profileOrganizationId(
  organizationId: string | null | undefined,
  profile: OwnerBearing
): string | undefined {
  return profileOwnerType(profile) === 'organization' ? (organizationId ?? undefined) : undefined;
}

/** The two buckets a list context renders, split by owner. */
export type ProfileOwnerBuckets<TProfile> = {
  orgProfiles: TProfile[];
  personalProfiles: TProfile[];
};

/**
 * Split the query data a list context reads into the two buckets the list
 * renders, mirroring the web dialog (`ProfilesListDialog.tsx:95-100`). An
 * organization context reads `agentProfiles.listCombined`, which carries both
 * buckets; a personal context reads `agentProfiles.list` and has no
 * organization bucket, whatever stale combined data is still cached.
 */
export function splitProfilesByOwner<TProfile>({
  isOrgContext,
  combined,
  personal,
}: Readonly<{
  isOrgContext: boolean;
  combined?: { orgProfiles: readonly TProfile[]; personalProfiles: readonly TProfile[] };
  personal?: readonly TProfile[];
}>): ProfileOwnerBuckets<TProfile> {
  if (isOrgContext) {
    return {
      orgProfiles: [...(combined?.orgProfiles ?? [])],
      personalProfiles: [...(combined?.personalProfiles ?? [])],
    };
  }
  return { orgProfiles: [], personalProfiles: [...(personal ?? [])] };
}
