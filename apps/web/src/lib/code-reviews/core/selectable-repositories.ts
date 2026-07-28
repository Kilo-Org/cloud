/**
 * Repository-list builders shared by the code review settings UI and the REVIEW.md conversion route.
 *
 * Two callers with DIFFERENT inputs, on purpose:
 * - The general settings repo list (`ReviewConfigForm.selectableRepositories`) passes the fetched
 *   integration repos PLUS manually-added legacy entries.
 * - The conversion dialog and the server route's allowlist pass the fetched integration repos ONLY
 *   (manually-added entries are unverified client input and must not authorize a billable action).
 *
 * The sync guarantee is scoped to the CONVERSION path: the dialog and the route both build from the
 * fetched list only, via these helpers, so a repo the dialog offers is always one the route allows.
 * If manually-added entries are ever added back to the server-side allowlist, add them to the
 * conversion dialog's list too (or drop this guarantee), or the two will diverge.
 */

export type FetchedRepository = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
};

export type ManuallyAddedRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
};

export type SelectableRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
};

/** The deduped repository list offered for review config / conversion (fetched + legacy manual). */
export function buildSelectableRepositories(
  fetched: readonly FetchedRepository[],
  manuallyAdded: readonly ManuallyAddedRepository[]
): SelectableRepository[] {
  const canonical: SelectableRepository[] = fetched.map(repo => ({
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
  }));
  const seenIds = new Set(canonical.map(repo => repo.id));
  const legacy = manuallyAdded.filter(repo => !seenIds.has(repo.id));
  return [...canonical, ...legacy];
}

/** The set of allowed repository full names, for server-side authorization of a chosen repo. */
export function buildAllowedRepositoryFullNames(
  fetched: readonly FetchedRepository[],
  manuallyAdded: readonly ManuallyAddedRepository[]
): Set<string> {
  return new Set(buildSelectableRepositories(fetched, manuallyAdded).map(repo => repo.full_name));
}
