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

/** How a group form leaves to the Groups list. */
export type OrgGroupFormExit =
  | { kind: 'list'; /** The key of the list route the pop-to truncates to. */ listRouteKey: string }
  | { kind: 'back' }
  | { kind: 'push-list' };

/**
 * The way out of a saved group's form.
 *
 * The reader reaches this form from the Groups list, so returning to it truncates
 * the stack with one pop-to commit over the list that is already beneath. That
 * truncation also cuts a form the reader can never see again: the create form
 * this screen replaced on the first save stays in the stack when the retire that
 * `stack-safe-replace` schedules is dropped (its transition end is lost inside
 * the hook's short bound), and a plain pop would then land on that stale create
 * form, prefilled with the saved group's name — one Save away from a duplicate.
 *
 * Pop-to with no matching route rewrites the stack in one commit — the
 * remove-and-insert shape that crashes the Android native stack
 * (`stack-safe-replace.ts`) — so when no list is beneath, the form goes back to
 * the route that opened it. A form with nothing beneath it — restored or linked
 * as the only route of its stack — has neither a pop to make nor a list to
 * reuse: it replaces itself with the list through the stack-safe replace.
 */
export function orgGroupFormExit({
  routes,
  currentIndex,
  listRouteName,
}: Readonly<{
  /** The routes of the Stack this form is mounted in, bottom first. */
  routes: readonly { readonly name: string; readonly key: string }[];
  /** The index of this form in `routes`. */
  currentIndex: number;
  /** The route name the Groups list registers in this Stack. */
  listRouteName: string;
}>): OrgGroupFormExit {
  // The nearest list beneath: the pop-to truncates the stack to it, so its key
  // is the scene the leave reveals.
  const listIndex = routes
    .slice(0, Math.max(currentIndex, 0))
    .findLastIndex(route => route.name === listRouteName);
  if (listIndex !== -1) {
    const route = routes[listIndex];
    if (route !== undefined) {
      return { kind: 'list', listRouteKey: route.key };
    }
  }
  return currentIndex <= 0 ? { kind: 'push-list' } : { kind: 'back' };
}
