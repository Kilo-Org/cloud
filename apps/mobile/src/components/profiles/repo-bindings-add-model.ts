import { type RepoOption } from '@/components/profiles/repo-bindings-model';
import { type OrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';

/** A profile as one of the Add form's pickers lists it. */
type ProfileChoice = Readonly<{ id: string; name: string }>;

/** What the Add form's repo field holds. */
export type ChosenRepo =
  | { readonly kind: 'none' }
  | { readonly kind: 'chosen'; readonly repo: RepoOption };

/**
 * What the Add form's profile field holds. `missing` is a stored id whose
 * profile is no longer in the list, which is not a choice this device can
 * submit.
 */
export type ChosenProfile =
  | { readonly kind: 'none' }
  | { readonly kind: 'chosen'; readonly profile: ProfileChoice }
  | { readonly kind: 'missing'; readonly profileId: string };

/**
 * The picker's empty-state copy. It names the profile a user could select in
 * this context: a personal one, an organization one, or — without the manage
 * role — who can create an organization profile, since the server rejects the
 * create itself. While the role is still resolving it names the organization
 * profile the context lists: the read-only copy would tell an owner or admin
 * they cannot act on what they can.
 */
const PICKER_EMPTY_DESCRIPTION_KEYS = {
  personal: 'profiles.emptyDescription',
  organization: 'profiles.repoBindings.pickerEmptyDescriptionOrganization',
  organizationReadOnly: 'profiles.repoBindings.pickerEmptyDescriptionOrganizationReadOnly',
} as const;

type PickerEmptyDescriptionKey =
  (typeof PICKER_EMPTY_DESCRIPTION_KEYS)[keyof typeof PICKER_EMPTY_DESCRIPTION_KEYS];

export function pickerEmptyDescriptionKey(
  organizationId: string | undefined,
  permission: OrganizationProfilePermission
): PickerEmptyDescriptionKey {
  if (organizationId === undefined) {
    return PICKER_EMPTY_DESCRIPTION_KEYS.personal;
  }
  return permission === 'read-only'
    ? PICKER_EMPTY_DESCRIPTION_KEYS.organizationReadOnly
    : PICKER_EMPTY_DESCRIPTION_KEYS.organization;
}

/* A stored id is not a choice: the list refetches when the app comes back, and
   the profile it named can have been deleted from another device. The field
   then names the reason and Add stays out of reach, rather than submitting an
   id this device no longer lists. */
export function chosenProfileOf(
  selectedProfileId: string,
  profiles: readonly ProfileChoice[]
): ChosenProfile {
  if (selectedProfileId === '') {
    return { kind: 'none' };
  }
  const profile = profiles.find(candidate => candidate.id === selectedProfileId);
  return profile === undefined
    ? { kind: 'missing', profileId: selectedProfileId }
    : { kind: 'chosen', profile };
}
