export type SessionBranchScope = {
  displayedKiloSessionId: string | null;
  displayedWorktreeId: string | null;
};

export type SessionBranchMetadata = {
  kiloSessionId: string;
  worktreeId?: string | null;
  branch: string | null;
};

export function resolveSessionBranch({
  scope,
  metadata,
}: {
  scope: SessionBranchScope;
  metadata: SessionBranchMetadata | null;
}): string | null {
  if (scope.displayedKiloSessionId === null && scope.displayedWorktreeId === null) {
    return null;
  }

  const matchesChat =
    scope.displayedKiloSessionId !== null &&
    metadata?.kiloSessionId === scope.displayedKiloSessionId;
  const matchesWorktree =
    scope.displayedKiloSessionId === null &&
    scope.displayedWorktreeId !== null &&
    metadata?.worktreeId === scope.displayedWorktreeId;

  const branch = matchesChat || matchesWorktree ? metadata?.branch?.trim() : undefined;
  return branch || null;
}
