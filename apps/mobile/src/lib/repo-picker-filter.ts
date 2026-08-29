import { repositoryLabel } from '@/components/agents/new-session-repository-state';
import { type RepoOption } from '@/lib/picker-bridge';

export function filterRepoPickerOptions<T extends RepoOption>({
  repositories,
  search,
}: {
  repositories: T[];
  search: string;
}) {
  const query = search.toLowerCase().trim();
  if (!query) {
    return repositories;
  }
  return repositories.filter(repo => repositoryLabel(repo).toLowerCase().includes(query));
}
