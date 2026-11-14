import { atom } from 'jotai';

export type StackedWorkspaceTarget = {
  worktreeId: string;
  branch: string;
  repository: string;
  prNumber: number | null;
  organizationId: string | null;
};

/** Set by the sidebar or chat header before opening the new-session composer. */
export const stackedWorkspaceTargetAtom = atom<StackedWorkspaceTarget | null>(null);
