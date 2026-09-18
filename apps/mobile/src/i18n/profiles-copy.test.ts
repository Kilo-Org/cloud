import { describe, expect, it } from 'vitest';

import en from './locales/en.json';

/**
 * The profile-manager screens are written against these key names, so this
 * literal is the interface: adding or renaming a key here means the screens
 * that cite it must change too.
 */
const EXPECTED_PROFILES = {
  title: 'Profiles',
  entrySubtitle: 'Reuse environment settings across sessions',
  newProfile: 'New profile',
  emptyTitle: 'No profiles yet',
  emptyDescription:
    'Create a profile to reuse environment variables, setup commands, and skills across sessions.',
  loadFailed: "Couldn't load profiles",
  nameLabel: 'Profile name',
  namePlaceholder: 'e.g. Backend debugging',
  descriptionLabel: 'Profile description',
  descriptionPlaceholder: 'Optional description',
  ownerLabel: 'Profile owner',
  nameRequired: 'Enter a profile name',
  createAction: 'Create profile',
  createFailed: "Couldn't create profile",
  createdToast: 'Profile "{{name}}" created',
  settingsSectionTitle: 'Configuration',
  defaultSectionTitle: 'Default profile',
  personalDefaultDescription: 'Auto-loaded when no repository has a pinned profile.',
  organizationDefaultDescription: 'Auto-loaded for members who have no personal default.',
  setAsDefault: 'Set as default',
  removeDefault: 'Remove as default',
  saveFailed: "Couldn't save profile",
  deleteTitle: 'Delete profile',
  deleteMessage: 'This permanently removes the profile and its settings. This cannot be undone.',
  deleteFailed: "Couldn't delete profile",
  deleteBlocked: 'This profile is used by a webhook trigger. Remove it from those triggers first.',
  deletedToast: 'Profile "{{name}}" deleted',
  variablesTitle: 'Environment variables',
  addVariable: 'Add variable',
  keyLabel: 'Key',
  valueLabel: 'Value',
  secretLabel: 'Secret',
  variablesEmpty: 'No variables yet',
  variablesSaveFailed: "Couldn't save variable",
  commandsTitle: 'Setup commands',
  addCommand: 'Add command',
  commandLabel: 'Command',
  commandPlaceholder: 'e.g. pnpm install',
  commandsEmpty: 'No setup commands yet',
  commandsSaveFailed: "Couldn't save setup commands",
  moveUp: 'Move up',
  moveDown: 'Move down',
  skillsTitle: 'Skills',
  addSkill: 'Add skill',
  skillNameLabel: 'Skill name',
  skillMarkdownLabel: 'Skill content',
  skillsEmpty: 'No skills yet',
  skillNameRequired: 'Enter a skill name',
  skillNameInvalid:
    'Skill name must start with a letter or digit and use only lowercase letters, digits, and dashes',
  skillContentRequired: 'Skill content is required',
  skillSaveFailed: "Couldn't save skill",
  skillsHint:
    'Paste a SKILL.md and its name fills in; add a skill from your phone without drag and drop.',
  skillEditTitle: 'Edit skill',
} as const;

describe('profiles copy', () => {
  it('pins the profile-manager key set', () => {
    expect(en.profiles).toEqual(EXPECTED_PROFILES);
  });
});
