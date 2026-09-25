import {
  formatGitUrlProject,
  type ProjectFilterOption,
} from '@/components/agents/session-list-helpers';

/**
 * Platform rows the sheet offers: every platform the caller supplies, plus any
 * selected platform it no longer offers, so a saved filter stays removable.
 * Deduped in first-seen order, which keeps the caller's rows in their order.
 */
export function mergePlatformOptions(
  platformOptions: readonly string[],
  selectedPlatforms: readonly string[]
): string[] {
  return [...new Set([...platformOptions, ...selectedPlatforms])];
}

/**
 * One project row per repository the caller offers, plus a fallback row for a
 * selected repository it no longer offers (it dropped out of the recent set).
 * Iteration order is the caller's option order, so the rows keep the order the
 * caller supplied; the returned map is never mutated after it is built.
 */
export function buildProjectRows(
  projectOptions: readonly ProjectFilterOption[],
  selectedProjects: readonly string[]
): Map<string, ProjectFilterOption> {
  const rowsByUrl = new Map(projectOptions.map(project => [project.gitUrl, project]));
  for (const gitUrl of selectedProjects) {
    if (!rowsByUrl.has(gitUrl)) {
      rowsByUrl.set(gitUrl, { gitUrl, displayName: formatGitUrlProject(gitUrl) });
    }
  }
  return rowsByUrl;
}
