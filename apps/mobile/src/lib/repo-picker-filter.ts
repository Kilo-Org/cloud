type NamedRepository = { fullName: string };

/**
 * The rows a repository picker keeps for a query: a case-insensitive substring
 * of the provider's `owner/name`, in the order the caller passed them.
 *
 * A blank query matches every row, so clearing the search field restores the
 * list a reader started from. Filtering decides what is drawn and nothing else:
 * a selection is stored by repository id, so a row the query hides keeps its
 * selection and reappears checked when the query clears.
 */
export function filterRepoPickerOptions<T extends NamedRepository>({
  repositories,
  search,
}: {
  repositories: T[];
  search: string;
}): T[] {
  const query = search.toLowerCase().trim();
  if (!query) {
    return repositories;
  }
  return repositories.filter(repo => repo.fullName.toLowerCase().includes(query));
}
