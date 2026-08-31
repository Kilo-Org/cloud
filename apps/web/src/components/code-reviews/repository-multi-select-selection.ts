/** The repositories the picker lists. Forks drop out only when the user hides them. */
export function visibleRepositories<T extends { fork?: boolean }>(
  repositories: readonly T[],
  hideForks: boolean
): T[] {
  return hideForks ? repositories.filter(repository => !repository.fork) : [...repositories];
}

/** Select-all adds the listed repositories and keeps selections the fork filter hides. */
export function withVisibleSelected<TId>(
  selectedIds: readonly TId[],
  visibleIds: readonly TId[]
): TId[] {
  return [...new Set([...selectedIds, ...visibleIds])];
}

/** Deselect-all clears the listed repositories and keeps selections the fork filter hides. */
export function withoutVisibleSelected<TId>(
  selectedIds: readonly TId[],
  visibleIds: readonly TId[]
): TId[] {
  const visible = new Set(visibleIds);
  return selectedIds.filter(id => !visible.has(id));
}
