export type SessionBranchDisplay =
  | { kind: 'branch'; branch: string }
  | { kind: 'assigning' }
  | { kind: 'unavailable' };

export type SessionBranchScope = {
  displayedKiloSessionId: string | null;
  displayedWorktreeId: string | null;
};

export type SessionBranchMetadata = {
  kiloSessionId: string;
  worktreeId?: string | null;
  branch: string | null;
};

export function resolveSessionBranchDisplay({
  scope,
  metadata,
  isPreparing,
}: {
  scope: SessionBranchScope;
  metadata: SessionBranchMetadata | null;
  isPreparing: boolean;
}): SessionBranchDisplay {
  if (scope.displayedKiloSessionId === null && scope.displayedWorktreeId === null) {
    return { kind: 'unavailable' };
  }

  const matchesChat =
    scope.displayedKiloSessionId !== null &&
    metadata?.kiloSessionId === scope.displayedKiloSessionId;
  const matchesWorktree =
    scope.displayedKiloSessionId === null &&
    scope.displayedWorktreeId !== null &&
    metadata?.worktreeId === scope.displayedWorktreeId;

  const branch = matchesChat || matchesWorktree ? metadata?.branch?.trim() : undefined;
  if (branch) return { kind: 'branch', branch };
  if (isPreparing) return { kind: 'assigning' };
  return { kind: 'unavailable' };
}
