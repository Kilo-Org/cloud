import { GitBranch } from 'lucide-react';
import { ContextUsageIndicator } from './ContextUsageIndicator';

/**
 * The repository, branch and context usage under the composer. With `reserve`,
 * the row keeps its height while empty, so the composer does not move when
 * the session resolves.
 */
export function ComposerContextLine({
  reserve,
  repository,
  branch,
  contextTokens,
  contextWindow,
}: {
  reserve: boolean;
  repository: string | undefined;
  branch: string | undefined;
  contextTokens: number | undefined;
  contextWindow: number | undefined;
}) {
  const hasUsage = contextTokens !== undefined && contextWindow !== undefined;
  if (!reserve && !repository && !branch && !hasUsage) return null;

  return (
    <div className="text-muted-foreground flex min-h-11 items-center gap-3 px-[max(1rem,calc(50%_-_27rem))] pb-3 text-xs md:min-h-12 md:pb-4">
      {(repository || branch) && (
        <div className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="h-3 w-3 shrink-0" />
          {repository && <span className="truncate">{repository}</span>}
          {branch && (
            <>
              {repository && <span>·</span>}
              <span className="truncate">{branch}</span>
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
