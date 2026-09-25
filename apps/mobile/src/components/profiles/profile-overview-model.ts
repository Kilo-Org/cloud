/**
 * Pure view-model helpers for the profile Overview screen.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-overview-model.test.ts`. The screen owns rendering; this
 * module owns the default-row copy selection, the delete failure
 * classification, and the three section rows the Overview lists.
 */

/** The `profiles.*` keys the default row's switch reads its label from. */
const SET_DEFAULT_LABEL_KEY = 'profiles.setAsDefault';
const REMOVE_DEFAULT_LABEL_KEY = 'profiles.removeDefault';

/**
 * Label for the default toggle. The label names the action a press performs,
 * so it flips with the profile's current default state.
 */
export function defaultControlLabel(isDefault: boolean): string {
  return isDefault ? REMOVE_DEFAULT_LABEL_KEY : SET_DEFAULT_LABEL_KEY;
}

/**
 * Copy for the default row's subtitle. An org-owned profile explains the
 * organization rule; a personal profile explains the personal rule.
 */
export function defaultDescriptionKey(isOrgOwned: boolean): string {
  return isOrgOwned
    ? 'profiles.organizationDefaultDescription'
    : 'profiles.personalDefaultDescription';
}

export type DeleteErrorKind = 'blocked' | 'failed';

/**
 * Classify a failed profile delete. The server refuses a delete with
 * `PRECONDITION_FAILED` when a webhook trigger still references the profile
 * (`agent-profiles-router.ts`); anything else is a plain failure.
 */
export function deleteErrorMessage(error: unknown): DeleteErrorKind {
  const code = (error as { data?: { code?: unknown } } | null | undefined)?.data?.code;
  return code === 'PRECONDITION_FAILED' ? 'blocked' : 'failed';
}

export type OverviewSectionKey =
  | 'variables'
  | 'commands'
  | 'slashCommands'
  | 'mcp'
  | 'skills'
  | 'agents';

/** One navigable section row: its route key, catalog title, and item count. */
export type OverviewSectionRow = Readonly<{
  key: OverviewSectionKey;
  titleKey: string;
  count: number;
}>;

/**
 * Remount key for the uncontrolled metadata form. It changes only when the
 * metadata the form seeds changes, so a refetch triggered by something else —
 * the default toggle invalidates the detail query — keeps the mounted form and
 * the user's unsaved name/description edits. `updatedAt` is unusable here: the
 * server bumps it on every write, including the default toggle.
 */
export function metadataFormKey(profile: { name: string; description: string | null }): string {
  return JSON.stringify([profile.name, profile.description ?? '']);
}

/** The arrays the Overview counts. Structural, so a test needs no tRPC type. */
export type ProfileOverviewSource = {
  vars: readonly unknown[];
  commands: readonly unknown[];
  kiloCommands: readonly unknown[];
  mcpServers: readonly unknown[];
  skills: readonly unknown[];
  agents: readonly unknown[];
};

/**
 * The Overview section rows, always in the same order so the screen's layout
 * never depends on the counts. The order mirrors the web editor's tabs.
 */
export function overviewSectionRows(profile: ProfileOverviewSource): OverviewSectionRow[] {
  return [
    { key: 'variables', titleKey: 'profiles.variablesTitle', count: profile.vars.length },
    { key: 'commands', titleKey: 'profiles.commandsTitle', count: profile.commands.length },
    {
      key: 'slashCommands',
      titleKey: 'profiles.slashCommands.title',
      count: profile.kiloCommands.length,
    },
    { key: 'mcp', titleKey: 'profiles.mcp.title', count: profile.mcpServers.length },
    { key: 'skills', titleKey: 'profiles.skillsTitle', count: profile.skills.length },
    { key: 'agents', titleKey: 'profiles.agents.title', count: profile.agents.length },
  ];
}
