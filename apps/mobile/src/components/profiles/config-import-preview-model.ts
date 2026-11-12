/**
 * Pure view-model for the profile config-import sheet.
 *
 * No React and no React Native imports. The sheet renders these rows and sends
 * `importSelectionRequest` straight to `applyConfigImport`, which is why the
 * section ids and the selection live here rather than in the component.
 */

/** One category of the server's diff, reduced to what the sheet renders. */
type PreviewCategoryDiff<T> = Readonly<{
  added: readonly Readonly<{ id: string; item: T }>[];
  changed: readonly Readonly<{ id: string; after: T }>[];
}>;

/**
 * The server preview this sheet renders, stated structurally: the tRPC output
 * satisfies it, and a test can build one without the whole profile contract.
 */
export type ImportPreviewInput = Readonly<{
  agents: PreviewCategoryDiff<{ slug: string }>;
  commands: PreviewCategoryDiff<{ name: string }>;
  skills: PreviewCategoryDiff<{ name: string }>;
  instructions: PreviewCategoryDiff<{ name: string }>;
  issues: readonly Readonly<{ severity: 'error' | 'warning'; message: string }>[];
}>;

/** The categories the server diffs, in the order the sheet lists them. */
type ImportCategory = 'agents' | 'commands' | 'skills' | 'instructions';

/** Whether the reader keeps each category of the preview. */
export type ImportSelection = Record<ImportCategory, boolean>;

/** One preview row: what the archive would add or change. */
export type ImportCategoryView = Readonly<{
  category: ImportCategory;
  /** The section's copy key: the shared `profiles.*` title for the collection. */
  titleKey: string;
  items: readonly Readonly<{
    id: string;
    label: string;
    status: 'added' | 'changed';
  }>[];
}>;

/** One issue the server reported for the archive or the config inside it. */
export type ImportIssueView = Readonly<{
  severity: 'error' | 'warning';
  message: string;
}>;

function toView<T>({
  category,
  titleKey,
  added,
  changed,
  label,
}: Readonly<{
  category: ImportCategory;
  titleKey: string;
  added: PreviewCategoryDiff<T>['added'];
  changed: PreviewCategoryDiff<T>['changed'];
  label: (item: T) => string;
}>): ImportCategoryView {
  return {
    category,
    titleKey,
    items: [
      ...added.map(entry => ({ id: entry.id, label: label(entry.item), status: 'added' as const })),
      ...changed.map(entry => ({
        id: entry.id,
        label: label(entry.after),
        status: 'changed' as const,
      })),
    ],
  };
}

/**
 * The preview as the sheet lists it. A category with nothing to import is
 * dropped, so the sheet never renders an empty section; `hasImportableItems`
 * then says whether anything is left to import at all.
 */
export function importCategoryViews(preview: ImportPreviewInput): ImportCategoryView[] {
  return [
    toView({
      category: 'agents',
      titleKey: 'common.agents',
      added: preview.agents.added,
      changed: preview.agents.changed,
      label: item => item.slug,
    }),
    toView({
      category: 'commands',
      titleKey: 'profiles.slashCommands.title',
      added: preview.commands.added,
      changed: preview.commands.changed,
      label: item => item.name,
    }),
    toView({
      category: 'skills',
      titleKey: 'profiles.skillsTitle',
      added: preview.skills.added,
      changed: preview.skills.changed,
      label: item => item.name,
    }),
    toView({
      category: 'instructions',
      titleKey: 'profiles.instructionsTitle',
      added: preview.instructions.added,
      changed: preview.instructions.changed,
      label: item => item.name,
    }),
  ].filter(section => section.items.length > 0);
}

/** Whether the archive holds anything this profile does not already have. */
export function hasImportableItems(views: readonly ImportCategoryView[]): boolean {
  return views.length > 0;
}

/** Every section with something to import starts selected, the way the web does. */
export function defaultImportSelection(views: readonly ImportCategoryView[]) {
  const selection = { agents: false, commands: false, skills: false, instructions: false };
  for (const section of views) {
    selection[section.category] = true;
  }
  return selection;
}

/** How many definitions the current selection imports. */
export function selectedImportCount(
  views: readonly ImportCategoryView[],
  selection: ImportSelection
): number {
  return views.reduce(
    (total, section) => total + (selection[section.category] ? section.items.length : 0),
    0
  );
}

/** How many of the selected definitions replace an existing cloud definition. */
export function selectedOverwriteCount(
  views: readonly ImportCategoryView[],
  selection: ImportSelection
): number {
  return views.reduce(
    (total, section) =>
      total +
      (selection[section.category]
        ? section.items.filter(item => item.status === 'changed').length
        : 0),
    0
  );
}

/** The id lists `applyConfigImport` takes for the current selection. */
export function importSelectionRequest(
  views: readonly ImportCategoryView[],
  selection: ImportSelection
) {
  const idsFor = (category: ImportCategory): string[] =>
    views
      .filter(section => section.category === category && selection[category])
      .flatMap(section => section.items.map(item => item.id));
  return {
    agents: idsFor('agents'),
    commands: idsFor('commands'),
    skills: idsFor('skills'),
    instructions: idsFor('instructions'),
  };
}

/** The server's archive and config issues, in the order it reported them. */
export function importIssueViews(preview: ImportPreviewInput): ImportIssueView[] {
  return preview.issues.map(issue => ({ severity: issue.severity, message: issue.message }));
}
