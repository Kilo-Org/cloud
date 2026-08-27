import {
  REPO_PLATFORM_LABEL_KEYS,
  type RepoOption,
  type RepoPickerSection,
  type RepoPlatform,
} from '@/lib/picker-bridge';

const PROVIDER_SECTION_ORDER: readonly RepoPlatform[] = ['github', 'gitlab', 'bitbucket'];

export function filterRepoPickerOptions({
  repositories,
  search,
}: {
  repositories: RepoOption[];
  search: string;
}) {
  const query = search.toLowerCase().trim();
  if (!query) {
    return repositories;
  }
  return repositories.filter(
    repo =>
      repo.fullName.toLowerCase().includes(query) ||
      repo.platformAccountLogin?.toLowerCase().includes(query)
  );
}

export function groupRepoPickerOptions(repositories: RepoOption[]): RepoPickerSection[] {
  const sections: RepoPickerSection[] = [];
  for (const platform of PROVIDER_SECTION_ORDER) {
    const providerRepositories = repositories.filter(repo => repo.platform === platform);
    if (platform === 'github') {
      const byAccount = new Map<string | undefined, RepoOption[]>();
      for (const repository of providerRepositories) {
        const group = byAccount.get(repository.platformAccountLogin) ?? [];
        group.push(repository);
        byAccount.set(repository.platformAccountLogin, group);
      }
      for (const [accountLogin, repos] of byAccount) {
        sections.push(
          accountLogin
            ? { key: `github:${accountLogin}`, title: accountLogin, repos }
            : { key: 'github', titleKey: REPO_PLATFORM_LABEL_KEYS.github, repos }
        );
      }
    } else if (providerRepositories.length > 0) {
      sections.push({
        key: platform,
        titleKey: REPO_PLATFORM_LABEL_KEYS[platform],
        repos: providerRepositories,
      });
    }
  }
  return sections;
}
