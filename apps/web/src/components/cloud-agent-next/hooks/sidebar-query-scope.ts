export function sidebarQueryInput(queryKey: readonly unknown[]) {
  const options = queryKey[1];
  if (!options || typeof options !== 'object' || !('input' in options)) return null;
  const input = options.input;
  if (!input || typeof input !== 'object') return null;
  return {
    organizationId: 'organizationId' in input ? input.organizationId : undefined,
    worktreeIds: 'worktreeIds' in input ? input.worktreeIds : undefined,
    worktreeId: 'worktreeId' in input ? input.worktreeId : undefined,
  };
}
