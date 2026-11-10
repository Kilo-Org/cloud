'use client';

import { AlertCircle, GitBranch, GitPullRequest, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { contextSegmentClassName, SegmentText } from './session-context-segments';

export type StackedOnStatus = 'ready' | 'loading' | 'missing';

type StackedOnSegmentProps = {
  branch: string;
  prNumber: number | null;
  status: StackedOnStatus;
  onRemove: () => void;
};

/** The stack base of a new session: the parent workspace's branch and pull request. */
export function StackedOnSegment({ branch, prNumber, status, onRemove }: StackedOnSegmentProps) {
  const pullRequest = prNumber !== null ? ` (pull request #${prNumber})` : '';
  return (
    <span
      className={cn(
        contextSegmentClassName,
        'pr-1',
        status === 'missing'
          ? 'bg-status-destructive-surface text-status-destructive'
          : 'text-foreground'
      )}
      title={`Base branch ${branch}${pullRequest}. The new session creates its own branch from it and opens its pull request against it.`}
    >
      <StatusIcon status={status} hasPullRequest={prNumber !== null} />
      <span className={cn('shrink-0', status !== 'missing' && 'text-muted-foreground')}>
        Stacked on
      </span>
      {prNumber !== null && <span className="shrink-0">#{prNumber}</span>}
      <SegmentText>
        <code className="font-mono">{branch}</code>
      </SegmentText>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove stacked workspace"
        title="Remove stacked workspace"
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm p-0.5 focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}

function StatusIcon({
  status,
  hasPullRequest,
}: {
  status: StackedOnStatus;
  hasPullRequest: boolean;
}) {
  if (status === 'loading') {
    return (
      <>
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        <span role="status" className="sr-only">
          Loading the stacked workspace.
        </span>
      </>
    );
  }
  if (status === 'missing') return <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />;
  const Icon = hasPullRequest ? GitPullRequest : GitBranch;
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />;
}
