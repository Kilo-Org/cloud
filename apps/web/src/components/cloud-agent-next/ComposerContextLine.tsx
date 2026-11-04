'use client';

import { GitBranch } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { useSavedWorktreeChanges } from './useSavedWorktreeChanges';

/**
 * The session repositories and context usage under the composer. With `reserve`,
 * the row keeps its height while empty, so the composer does not move when
 * the session resolves.
 */
export function ComposerContextLine({
  userId,
  reserve,
  repository,
  branch,
  environmentName,
  contextTokens,
  contextWindow,
  cloudAgentSessionId,
  organizationId,
  worktreeId,
}: {
  userId: string;
  reserve: boolean;
  repository: string | undefined;
  branch: string | undefined;
  environmentName?: string;
  contextTokens: number | undefined;
  contextWindow: number | undefined;
  cloudAgentSessionId?: string;
  organizationId?: string;
  worktreeId?: string;
}) {
  const { saved } = useSavedWorktreeChanges({
    userId,
    cloudAgentSessionId: cloudAgentSessionId ?? '',
    organizationId,
    worktreeId,
    enabled: Boolean(cloudAgentSessionId),
  });
  const repositories = saved.data?.snapshot?.repositories;
  const hasMultipleRepositories = repositories !== undefined && repositories.length > 1;
  const mainRepository = repository || repositories?.[0]?.repoFullName;
  const hasUsage = contextTokens !== undefined && contextWindow !== undefined;
  if (!reserve && !repository && !branch && !environmentName && !hasUsage && !hasMultipleRepositories)
    return null;

  return (
    <div className="text-muted-foreground flex min-h-11 items-center gap-3 px-[max(1rem,calc(50%_-_27rem))] pb-3 text-xs md:min-h-12 md:pb-4">
      {(mainRepository || branch || environmentName) && (
        <div className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          {hasMultipleRepositories ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="hover:text-foreground focus-visible:ring-ring inline-flex min-w-0 items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="truncate">{mainRepository}</span>
                  <span className="shrink-0">
                    + {repositories.length - 1} {repositories.length === 2 ? 'repo' : 'repos'}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-[calc(100vw-2rem)] text-xs">
                <ul className="space-y-1">
                  {repositories.map(member => (
                    <li key={member.path} className="break-all">
                      {member.repoFullName}
                    </li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          ) : (
            mainRepository && <span className="truncate">{mainRepository}</span>
          )}
          {branch && (
            <>
              {mainRepository && <span>·</span>}
              <span className="truncate">{branch}</span>
            </>
          )}
          {environmentName && (
            <>
              {(mainRepository || branch) && <span>·</span>}
              <span className="truncate" title={`Environment: ${environmentName}`}>
                {environmentName}
              </span>
            </>
          )}
        </div>
      )}
      {/* Reserved so the usage arriving later does not re-truncate the
          repository and branch on narrow screens. */}
      <div className="ml-auto flex min-w-[4.5rem] shrink-0 justify-end">
        {hasUsage && (
          <ContextUsageIndicator contextTokens={contextTokens} contextWindow={contextWindow} />
        )}
      </div>
    </div>
  );
}
