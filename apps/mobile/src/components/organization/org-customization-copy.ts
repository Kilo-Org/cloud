import { type TFunction } from 'i18next';

/**
 * Copy for the organization's native custom-modes and groups screens.
 *
 * Each entry names the catalog key its string belongs to and carries the
 * reviewed English text the screen renders until the translation slice lands:
 * `check:i18n` fails on a catalog that lacks a key `en.json` gained, so a code
 * slice stages new copy the way `new-profile-screen.tsx` stages its owner
 * labels — the key is written down here, and `t()` reads it with the English
 * text as its fallback.
 *
 * The English text stays here rather than at each call site so one string has
 * one definition; the keys are named for what the string is, so the translator
 * sees the same context the screen does.
 */
const COPY = {
  modesCreate: ['organization.modes.create', 'New mode'],
  modesEmptyTitle: ['organization.modes.emptyTitle', 'No custom modes yet'],
  modesEmptyDescription: [
    'organization.modes.emptyDescription',
    'Modes added here are available to everyone in this organization.',
  ],
  modesNameLabel: ['organization.modes.nameLabel', 'Mode name'],
  modesIdentifierLabel: ['organization.modes.identifierLabel', 'Identifier'],
  modesIdentifierHint: [
    'organization.modes.identifierHint',
    'Lowercase letters, numbers, and hyphens.',
  ],
  modesRoleLabel: ['organization.modes.roleLabel', 'Role definition'],
  modesDescriptionLabel: ['organization.modes.descriptionLabel', 'Mode description'],
  modesWhenToUseLabel: ['organization.modes.whenToUseLabel', 'When to use this mode'],
  modesInstructionsLabel: ['organization.modes.instructionsLabel', 'Custom instructions'],
  modesToolsLabel: ['organization.modes.toolsLabel', 'Tools'],
  modesToolRead: ['organization.modes.tool.read', 'Read files'],
  modesToolEdit: ['organization.modes.tool.edit', 'Edit files'],
  modesToolBrowser: ['organization.modes.tool.browser', 'Use browser'],
  modesToolCommand: ['organization.modes.tool.command', 'Run commands'],
  modesToolMcp: ['organization.modes.tool.mcp', 'Use MCP'],
  modesRestrictionLabel: ['organization.modes.restrictionLabel', 'Restriction label'],
  modesRestrictionPattern: ['organization.modes.restrictionPattern', 'File pattern'],
  modesRestrictionHint: [
    'organization.modes.restrictionHint',
    'Only files that match this pattern can be edited. Leave it empty to allow every file.',
  ],
  modesRestrictionInvalid: ['organization.modes.restrictionInvalid', 'Enter a valid pattern.'],
  modesNameRequired: ['organization.modes.nameRequired', 'Enter a mode name.'],
  modesIdentifierRequired: ['organization.modes.identifierRequired', 'Enter an identifier.'],
  modesIdentifierInvalid: [
    'organization.modes.identifierInvalid',
    'Use lowercase letters, numbers, and hyphens only.',
  ],
  modesIdentifierTaken: [
    'organization.modes.identifierTaken',
    'Another mode already uses this identifier.',
  ],
  modesRoleRequired: ['organization.modes.roleRequired', 'Describe what this mode does.'],
  modesDeleteAction: ['organization.modes.deleteAction', 'Delete mode'],
  modesDeleteTitle: ['organization.modes.deleteTitle', 'Delete this mode?'],
  modesDeleteMessage: [
    'organization.modes.deleteMessage',
    'The mode is removed for everyone in this organization. A mode that replaces a built-in one goes back to the built-in settings.',
  ],
  modesNotFound: ['organization.modes.notFound', 'This mode no longer exists.'],
  groupsCreate: ['organization.groups.create', 'New group'],
  groupsEmptyTitle: ['organization.groups.emptyTitle', 'No groups yet'],
  groupsEmptyDescription: [
    'organization.groups.emptyDescription',
    'A group gathers members so one policy can apply to all of them.',
  ],
  groupsNameLabel: ['organization.groups.nameLabel', 'Group name'],
  groupsDescriptionLabel: ['organization.groups.descriptionLabel', 'Group description'],
  groupsMembersLabel: ['organization.groups.membersLabel', 'Group members'],
  groupsSearchMembers: ['organization.groups.searchMembers', 'Search members'],
  groupsSelectAllVisible: ['organization.groups.selectAllVisible', 'Select everyone shown'],
  groupsMembersEmpty: ['organization.groups.membersEmpty', 'No active member matches your search.'],
  groupsMemberCount: ['organization.groups.memberCount', '{{displayCount}} members'],
  groupsMemberCountOne: ['organization.groups.memberCountOne', '{{displayCount}} member'],
  groupsNameRequired: ['organization.groups.nameRequired', 'Enter a group name.'],
  groupsNameTooLong: [
    'organization.groups.nameTooLong',
    'Keep the name to 80 characters or fewer.',
  ],
  groupsDeleteAction: ['organization.groups.deleteAction', 'Delete group'],
  groupsDeleteTitle: ['organization.groups.deleteTitle', 'Delete this group?'],
  groupsDeleteMessage: [
    'organization.groups.deleteMessage',
    'The group, its policies, and its member assignments are removed.',
  ],
  groupsNotFound: ['organization.groups.notFound', 'This group no longer exists.'],
  groupsPermissionDenied: [
    'organization.groups.permissionDenied',
    'Only an organization owner or admin can change its groups.',
  ],
  groupsMemberViewTitle: ['organization.groups.memberViewTitle', 'Your groups'],
  groupsMemberViewEmpty: [
    'organization.groups.memberViewEmpty',
    'You are not in any group of this organization.',
  ],
  groupsEnterpriseOnly: [
    'organization.groups.enterpriseOnly',
    'Groups are available on the Enterprise plan.',
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type OrgCustomizationCopyKey = keyof typeof COPY;

/** The copy for one key, in the reader's language once its catalog entry exists. */
export function orgCopy(
  t: TFunction,
  key: OrgCustomizationCopyKey,
  values?: Readonly<Record<string, string>>
): string {
  const [catalogKey, english] = COPY[key];
  return values === undefined
    ? t(catalogKey, { defaultValue: english })
    : t(catalogKey, { defaultValue: english, ...values });
}
