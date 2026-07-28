/**
 * Canonical "which repositories can this owner target" set, shared by the settings UI (the dialog
 * that builds conversion links) and the server route that authorizes the chosen repo. Both derive
 * from the same inputs — the integration's fetched repository list plus any manually-added legacy
 * entries — so the UI-offered list can't drift out of sync with the server-enforced allowlist.
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
