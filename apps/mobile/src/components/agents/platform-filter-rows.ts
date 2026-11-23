import { formatGitUrlProject } from '@kilocode/app-shared/git-url-project';

import { type ProjectFilterOption } from '@/components/agents/session-list-helpers';

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
 * Every project the filter sheet may offer, from the three sources the screen
 * has: the recent repositories, the rows the list renders, and the current
 * selection. The sheet must offer every project the list renders, because the
 * recent-repositories query covers only the last 30 days: a history of older
 * sessions would otherwise show no project row at all.
 *
 * The first occurrence of a git URL wins, so a selection keeps the label the
 * recent or rendered row already gave it. Rows are sorted by display name; the
 * spread copies the values, so no caller's array is mutated.
 *
 * No client-side cap applies. The server already bounds `recentProjects`
 * (LIMIT 10), and a cap here would silently drop the rows the user needs to
 * narrow the list.
 */
export function mergeProjectOptions(params: {
  recentProjects: readonly string[];
  sessionGitUrls: readonly (string | null | undefined)[];
  selectedProjects: readonly string[];
}): ProjectFilterOption[] {
  const byGitUrl = new Map<string, ProjectFilterOption>();
  for (const gitUrl of [
    ...params.recentProjects,
    ...params.sessionGitUrls,
    ...params.selectedProjects,
  ]) {
    if (gitUrl && !byGitUrl.has(gitUrl)) {
      byGitUrl.set(gitUrl, { gitUrl, displayName: formatGitUrlProject(gitUrl) });
    }
  }
  return (
    [...byGitUrl.values()]
      // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; the spread already copies so nothing shared is mutated
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  );
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
