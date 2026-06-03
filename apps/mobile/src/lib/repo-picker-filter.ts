import { type RepoOption } from '@/lib/picker-bridge';

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
  return repositories.filter(repo => repo.fullName.toLowerCase().includes(query));
}
