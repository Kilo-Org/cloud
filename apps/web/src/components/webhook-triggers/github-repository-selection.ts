import type { RepositoryOption } from '@/components/shared/RepositoryCombobox';

export type GitHubRepositorySelection = {
  repository: string;
  platformIntegrationId?: string;
  platformAccountLogin?: string;
};

export type GitHubRepositoryGroup = {
  key: string;
  label: string;
  repositories: RepositoryOption[];
};

export function shortIntegrationId(platformIntegrationId: string): string {
  return platformIntegrationId.slice(0, 8);
}

export function repositorySelection(option: RepositoryOption): GitHubRepositorySelection {
  return {
    repository: option.fullName,
    platformIntegrationId: option.platformIntegrationId,
    platformAccountLogin: option.platformAccountLogin,
  };
}

export function isSelectedRepository(
  option: RepositoryOption,
  selection: GitHubRepositorySelection
): boolean {
  return (
    option.fullName === selection.repository &&
    option.platformIntegrationId === selection.platformIntegrationId
  );
}

export function findSelectedRepository(
  repositories: RepositoryOption[],
  selection: GitHubRepositorySelection
): RepositoryOption | undefined {
  const matches = repositories.filter(option => isSelectedRepository(option, selection));
  return matches.length === 1 ? matches[0] : undefined;
}

function repositoryAccount(option: RepositoryOption): string {
  return option.platformAccountLogin ?? option.fullName.split('/')[0] ?? 'GitHub';
}

export function groupGitHubRepositories(repositories: RepositoryOption[]): GitHubRepositoryGroup[] {
  const groups = new Map<
    string,
    { account: string; integrationId?: string; repositories: RepositoryOption[] }
  >();

  for (const repository of repositories) {
    const account = repositoryAccount(repository);
    const key = repository.platformIntegrationId ?? `account:${account.toLowerCase()}`;
    const group = groups.get(key);
    if (group) {
      group.repositories.push(repository);
    } else {
      groups.set(key, {
        account,
        integrationId: repository.platformIntegrationId,
        repositories: [repository],
      });
    }
  }

  const accountCounts = new Map<string, number>();
  for (const group of groups.values()) {
    const account = group.account.toLowerCase();
    accountCounts.set(account, (accountCounts.get(account) ?? 0) + 1);
  }

  return [...groups.entries()].map(([key, group]) => ({
    key,
    label:
      (accountCounts.get(group.account.toLowerCase()) ?? 0) > 1 && group.integrationId
        ? `${group.account} (${shortIntegrationId(group.integrationId)})`
        : group.account,
    repositories: group.repositories,
  }));
}
