/**
 * Pure view-model helpers for the profile Overview screen.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-overview-model.test.ts`. The screen owns rendering; this
 * module owns the default-row copy selection, the delete failure
 * classification, and the three section rows the Overview lists.
 */

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

/**
 * The counts the Overview lists. Structural, so a test needs no tRPC type: the
 * server's `agentProfiles.overview` supplies them without transferring the
 * collections themselves.
 */
export type ProfileOverviewCounts = {
  varCount: number;
  commandCount: number;
  kiloCommandCount: number;
  mcpServerCount: number;
  skillCount: number;
  agentCount: number;
};

/**
 * The Overview section rows, always in the same order so the screen's layout
 * never depends on the counts. The order mirrors the web editor's tabs.
 */
export function overviewSectionRows(counts: ProfileOverviewCounts): OverviewSectionRow[] {
  return [
    { key: 'variables', titleKey: 'profiles.variablesTitle', count: counts.varCount },
    { key: 'commands', titleKey: 'profiles.commandsTitle', count: counts.commandCount },
    {
      key: 'slashCommands',
      titleKey: 'profiles.slashCommands.title',
      count: counts.kiloCommandCount,
    },
    { key: 'mcp', titleKey: 'profiles.mcp.title', count: counts.mcpServerCount },
    { key: 'skills', titleKey: 'profiles.skillsTitle', count: counts.skillCount },
    { key: 'agents', titleKey: 'profiles.agents.title', count: counts.agentCount },
  ];
}
