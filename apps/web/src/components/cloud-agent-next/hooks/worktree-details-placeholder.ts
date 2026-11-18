type WorktreeDetailsData<Detail> = { worktrees: Record<string, Detail> };
type CachedWorktreeDetailsQuery<Detail> = readonly [
  queryKey: readonly unknown[],
  data: WorktreeDetailsData<Detail> | undefined,
];

function queryOrganizationId(queryKey: readonly unknown[]): string | null | undefined {
  const params = queryKey[1];
  if (typeof params !== 'object' || params === null || !('input' in params)) return undefined;
  const input = params.input;
  if (typeof input !== 'object' || input === null || !('organizationId' in input)) return undefined;
  const organizationId = input.organizationId;
  return typeof organizationId === 'string' || organizationId === null ? organizationId : undefined;
}

/**
 * Details already cached for these worktrees by other batches in the same scope.
 * A new worktree changes the batch query key; showing what is known keeps every
 * other row's name in place while the new batch loads.
 */
export function getCachedWorktreeDetails<Detail>(
  cachedQueries: readonly CachedWorktreeDetailsQuery<Detail>[],
  worktreeIds: readonly string[],
  organizationId: string | null
): WorktreeDetailsData<Detail> | undefined {
  const worktrees: Record<string, Detail> = {};
  for (const [queryKey, data] of cachedQueries) {
    if (!data || queryOrganizationId(queryKey) !== organizationId) continue;
    for (const worktreeId of worktreeIds) {
      const detail = data.worktrees[worktreeId];
      if (detail !== undefined && !(worktreeId in worktrees)) worktrees[worktreeId] = detail;
    }
  }
  return Object.keys(worktrees).length > 0 ? { worktrees } : undefined;
}

type WorktreeDetailsQueryState<Detail> = {
  data?: WorktreeDetailsData<Detail>;
  isPending: boolean;
  isPlaceholderData: boolean;
};

/** Worktrees whose details have not arrived from any request yet. */
export function getLoadingWorktreeIds<Detail>(
  queries: readonly WorktreeDetailsQueryState<Detail>[],
  batches: readonly (readonly string[])[]
): string[] {
  return queries.flatMap((query, index) => {
    if (!query.isPending && !query.isPlaceholderData) return [];
    const known = query.data?.worktrees ?? {};
    return (batches[index] ?? []).filter(worktreeId => !(worktreeId in known));
  });
}
