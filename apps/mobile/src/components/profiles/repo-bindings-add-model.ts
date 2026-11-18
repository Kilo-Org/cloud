import { type RepoOption } from '@/components/profiles/repo-bindings-model';

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
 * The picker's empty-state copy. It names the profile a user can select in this
 * context: a personal one or an organization one. The picker opens only from
 * the Add control, which the manage slot withholds from a caller without the
 * manage role, so who may create an organization profile is never this copy's
 * to say — the slot states it.
 */
const PICKER_EMPTY_DESCRIPTION_KEYS = {
  personal: 'profiles.emptyDescription',
  organization: 'profiles.repoBindings.pickerEmptyDescriptionOrganization',
} as const;

type PickerEmptyDescriptionKey =
  (typeof PICKER_EMPTY_DESCRIPTION_KEYS)[keyof typeof PICKER_EMPTY_DESCRIPTION_KEYS];

export function pickerEmptyDescriptionKey(
  organizationId: string | undefined
): PickerEmptyDescriptionKey {
  return organizationId === undefined
    ? PICKER_EMPTY_DESCRIPTION_KEYS.personal
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
