import { type RepoOption } from '@/lib/picker-bridge';

export type RepoPickerSection = {
  title?: string;
  data: RepoOption[];
};

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
  const sections = new Map<string | undefined, RepoOption[]>();
  for (const repository of repositories) {
    const group = sections.get(repository.platformAccountLogin) ?? [];
    group.push(repository);
    sections.set(repository.platformAccountLogin, group);
  }
  return [...sections].map(([title, data]) => ({ title, data }));
}
