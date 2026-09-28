/**
 * Pure view-model helpers for the repo-profile bindings surface.
 *
 * Ports the web `RepoProfileBindingsDialog` option/merge logic
 * (`apps/web/src/components/cloud-agent/RepoProfileBindingsDialog.tsx:122-147`)
 * and the `RepoPinsSection` per-profile filter
 * (`apps/web/src/components/cloud-agent/ProfilesListDialog.tsx:952-957`) to the
 * phone. No React and no React Native imports: every function is unit-tested
 * directly in `repo-bindings-model.test.ts`.
 */

/** The two providers a binding can name; Bitbucket has no profile bindings. */
export type RepoBindingPlatform = 'github' | 'gitlab';

/** One repository as a picker option, merged from the two provider lists. */
export type RepoOption = Readonly<{
  platform: RepoBindingPlatform;
  fullName: string;
  private: boolean;
}>;

/** The provider row shape the merge reads; only the fields the option needs. */
export type RepoSource = Readonly<{ fullName: string; private: boolean }>;

/** The binding row shape `listRepoBindings` returns, structurally. */
export type RepoBindingLike = Readonly<{
  repoFullName: string;
  platform: string;
  profileId: string;
  profileName: string;
}>;

/**
 * Merge the GitHub and GitLab repository lists into one option list, GitHub
 * first — the web dialog's `unifiedRepositories` order.
 */
export function mergeRepositoryOptions(
  github: readonly RepoSource[],
  gitlab: readonly RepoSource[]
): RepoOption[] {
  return [
    ...github.map(repo => ({
      platform: 'github' as const,
      fullName: repo.fullName,
      private: repo.private,
    })),
    ...gitlab.map(repo => ({
      platform: 'gitlab' as const,
      fullName: repo.fullName,
      private: repo.private,
    })),
  ];
}

/** The stable identity of a picker row: platform plus full name. */
export function repositoryOptionKey(repo: RepoOption): string {
  return `${repo.platform}:${repo.fullName}`;
}

/** Case-insensitive full-name search; a blank query returns every option. */
export function filterRepositoryOptions(
  repositories: readonly RepoOption[],
  query: string
): RepoOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return [...repositories];
  }
  return repositories.filter(repo => repo.fullName.toLowerCase().includes(needle));
}

/**
 * Find the binding that already pins `repoFullName` on `platform`, matching the
 * server's lower-cased full name. Returns `undefined` when the repo is free.
 */
export function findRepoBinding<T extends RepoBindingLike>(
  bindings: readonly T[],
  repoFullName: string,
  platform: RepoBindingPlatform
): T | undefined {
  const target = repoFullName.toLowerCase();
  return bindings.find(
    binding => binding.platform === platform && binding.repoFullName.toLowerCase() === target
  );
}

/** The bindings that belong to one profile, for the Overview pins section. */
export function bindingsForProfile<T extends RepoBindingLike>(
  bindings: readonly T[],
  profileId: string
): T[] {
  return bindings.filter(binding => binding.profileId === profileId);
}

/** The two-letter provider badge the web dialog renders (`GH`/`GL`). */
export function repoPlatformBadge(platform: string): 'GH' | 'GL' {
  return platform === 'gitlab' ? 'GL' : 'GH';
}
