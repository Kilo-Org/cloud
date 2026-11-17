/**
 * The group form's rules, apart from the screen so they can be tested without a
 * renderer: the metadata bounds the server enforces
 * (`OrganizationGroupMetadataSchema`), and the member selection's add/remove
 * rules.
 */

/** `OrganizationGroupMetadataSchema.name` bound, and the field's `maxLength`. */
export const ORG_GROUP_NAME_MAX_LENGTH = 80;

/** `OrganizationGroupMetadataSchema.description` bound, and the field's `maxLength`. */
export const ORG_GROUP_DESCRIPTION_MAX_LENGTH = 500;

export type OrgGroupNameError = 'required' | 'tooLong' | null;

export function orgGroupNameError(name: string): OrgGroupNameError {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'required';
  }
  return trimmed.length > ORG_GROUP_NAME_MAX_LENGTH ? 'tooLong' : null;
}

/**
 * The member ids after one row's switch moves, kept in the order the person
 * selected them: the payload is a set, but a stable order keeps the saved list
 * from reshuffling.
 */
export function toggleOrgGroupMember(
  memberIds: readonly string[],
  memberId: string,
  selected: boolean
): readonly string[] {
  if (selected) {
    return memberIds.includes(memberId) ? memberIds : [...memberIds, memberId];
  }
  return memberIds.filter(id => id !== memberId);
}

/**
 * Select or clear every member in the current search result, leaving a
 * selection the filter hides untouched — the web panel's rule.
 */
export function toggleOrgGroupMembers(
  memberIds: readonly string[],
  visibleMemberIds: readonly string[],
  selected: boolean
): readonly string[] {
  if (!selected) {
    return memberIds.filter(id => !visibleMemberIds.includes(id));
  }
  const added = visibleMemberIds.filter(id => !memberIds.includes(id));
  return added.length === 0 ? memberIds : [...memberIds, ...added];
}

/** The selection after a group's stored membership loads, in one order. */
export function sortOrgGroupMemberIds(memberIds: readonly string[]): readonly string[] {
  // eslint-disable-next-line unicorn/no-array-sort -- toSorted() is not available in Hermes
  return [...memberIds].sort();
}

/**
 * What the member picker shows. The list query's phases are exclusive: a pending
 * fetch has nothing to filter yet and a failed one has nothing to offer, so
 * neither may read as "no active member matches your search".
 */
export type OrgGroupMemberPickerState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'list' };

export function selectOrgGroupMemberPickerState(
  query: Readonly<{ isPending: boolean; isError: boolean; hasData: boolean }>,
  visibleMemberCount: number
): OrgGroupMemberPickerState {
  if (query.isPending) {
    return { kind: 'loading' };
  }
  if (query.isError && !query.hasData) {
    return { kind: 'error' };
  }
  return visibleMemberCount === 0 ? { kind: 'empty' } : { kind: 'list' };
}

/** Whether a group form holds a change against the group it opened with. */
export function isOrgGroupFormDirty(
  values: Readonly<{ name: string; description: string; memberIds: readonly string[] }>,
  initial: Readonly<{ name: string; description: string; memberIds: readonly string[] }> | null
): boolean {
  if (initial === null) {
    return (
      values.name.trim().length > 0 ||
      values.description.trim().length > 0 ||
      values.memberIds.length > 0
    );
  }
  return (
    values.name !== initial.name ||
    values.description !== initial.description ||
    values.memberIds.length !== initial.memberIds.length ||
    values.memberIds.some(id => !initial.memberIds.includes(id))
  );
}
