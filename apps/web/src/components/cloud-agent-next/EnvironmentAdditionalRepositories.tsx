'use client';

import { GitBranch } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { EnvironmentMemberResponse } from '@/hooks/useCloudAgentEnvironments';
import { branchKey, type AdditionalBranches } from './environment-selection';

/**
 * The other repositories of a multi-repository environment. The session clones
 * each one beside the launch repository. A branch is optional: without one, the
 * repository starts on the session's new branch.
 */
export function EnvironmentAdditionalRepositories({
  repositories,
  branches,
  onBranchChange,
}: {
  repositories: EnvironmentMemberResponse[];
  branches: AdditionalBranches;
  onBranchChange: (member: EnvironmentMemberResponse, branch: string) => void;
}) {
  if (repositories.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Additional repositories">
      <p className="text-muted-foreground text-xs">
        This environment also clones these repositories. Set a branch for any of them, or leave it
        empty to start on a new branch.
      </p>
      <ul className="flex flex-col gap-1.5">
        {repositories.map(member => (
          <li key={branchKey(member)} className="flex min-w-0 items-center gap-2">
            <span
              className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-xs"
              title={member.repoFullName}
            >
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{member.repoFullName}</span>
            </span>
            <Input
              className="h-8 w-44 text-xs"
              placeholder="Branch (optional)"
              aria-label={`Branch for ${member.repoFullName}`}
              maxLength={255}
              value={branches[branchKey(member)] ?? ''}
              onChange={event => onBranchChange(member, event.target.value)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
