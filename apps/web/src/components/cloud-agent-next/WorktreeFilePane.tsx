'use client';

import { Component, Suspense, lazy, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorktreeFile } from './useWorktreeFile';
import type { WorktreeFileViewMode } from './workspace-tabs';
import type { WorktreeReviewCapture } from './worktree-review';
import type { WorktreeFileReviewBindings } from './worktree-review-bindings';

const WorktreeFileRenderer = lazy(() => import('./WorktreeFileRenderer'));

const stateMessages = {
  loading: 'Loading saved file…',
  error: 'Could not load this saved file. Try reloading the saved file.',
  stale: 'The saved capture changed. Reload the saved file to read the latest revision.',
  not_captured: 'No file content was saved for this capture.',
  no_longer_listed: 'This file is no longer listed in the latest saved changes.',
};

class RendererBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function FilePaneStatus({
  path,
  isFetching,
  onReload,
  message,
  role = 'status',
}: {
  path: string;
  isFetching: boolean;
  onReload: () => void;
  message: string;
  role?: 'status' | 'alert';
}) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2 sm:h-10">
        <p className="min-w-0 flex-1 truncate px-1 font-mono text-xs" title={path}>
          {path}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground h-11 w-11 shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 motion-reduce:transition-none sm:h-8 sm:w-8"
              aria-label="Reload saved file"
              aria-disabled={isFetching}
              onClick={() => {
                if (!isFetching) onReload();
              }}
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-4 ${isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Reload saved file without starting the workspace
          </TooltipContent>
        </Tooltip>
      </div>
      <p role={role} className="text-muted-foreground p-4 text-sm">
        {message}
      </p>
    </>
  );
}

export function WorktreeFilePane({
  cloudAgentSessionId,
  organizationId,
  path,
  mode,
  onModeChange,
  review,
  reviewScope,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  path: string;
  mode?: WorktreeFileViewMode;
  onModeChange: (mode: WorktreeFileViewMode) => void;
  review?: WorktreeFileReviewBindings;
  reviewScope?: { userId: string; organizationId?: string; workspaceScope: string };
}) {
  const { state, isFetching, reload } = useWorktreeFile({
    cloudAgentSessionId,
    organizationId,
    path,
  });
  const statusProps = { path, isFetching, onReload: () => void reload() };
  const reviewCapture: WorktreeReviewCapture | undefined =
    review &&
    reviewScope &&
    reviewScope.organizationId === organizationId &&
    cloudAgentSessionId.startsWith('workspace_') &&
    'file' in state
      ? {
          userId: reviewScope.userId,
          organizationId: reviewScope.organizationId,
          workspaceScope: reviewScope.workspaceScope,
          sourceCloudAgentSessionId: cloudAgentSessionId,
          revision: state.file.revision,
          capturedAt: state.capturedAt,
          comparison: state.comparison,
        }
      : undefined;

  return (
    <div
      className="bg-background text-foreground flex h-full min-h-0 min-w-0 flex-col"
      aria-busy={isFetching}
    >
      {'file' in state ? (
        <RendererBoundary
          key={JSON.stringify([organizationId, cloudAgentSessionId, path, state.file.revision])}
          fallback={
            <FilePaneStatus
              {...statusProps}
              role="alert"
              message="This saved file could not be rendered. Try another view or reload the page."
            />
          }
        >
          <Suspense
            fallback={<FilePaneStatus {...statusProps} message="Loading saved file viewer…" />}
          >
            <WorktreeFileRenderer
              file={state.file}
              mode={mode ?? 'diff'}
              capturedAt={state.capturedAt}
              onModeChange={onModeChange}
              isFetching={isFetching}
              onReload={statusProps.onReload}
              review={reviewCapture ? review : undefined}
              reviewCapture={reviewCapture}
            />
          </Suspense>
        </RendererBoundary>
      ) : (
        <FilePaneStatus
          {...statusProps}
          role={state.status === 'error' ? 'alert' : 'status'}
          message={
            state.status === 'stale' && isFetching
              ? 'The saved capture changed. Loading the latest saved revision…'
              : stateMessages[state.status]
          }
        />
      )}
    </div>
  );
}
