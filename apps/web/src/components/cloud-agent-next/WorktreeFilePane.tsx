'use client';

import { Component, Suspense, lazy, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';
import { useWorktreeFile } from './useWorktreeFile';
import type { WorktreeFileViewMode } from './workspace-tabs';
import type { WorktreeReviewCapture } from './worktree-review';
import type { WorktreeFileReviewBindings } from './worktree-review-bindings';

const WorktreeFileRenderer = lazy(() => import('./WorktreeFileRenderer'));

const stateMessages = {
  loading: 'Loading saved file…',
  error: 'Could not load this saved file.',
  stale: 'The saved capture changed.',
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
  showReload = false,
}: {
  path: string;
  isFetching: boolean;
  onReload: () => void;
  message: string;
  role?: 'status' | 'alert';
  showReload?: boolean;
}) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2 sm:h-10">
        <div className="flex min-w-0 flex-1 items-center">
          <p className="min-w-0 truncate px-1 font-mono text-xs" title={path}>
            {path}
          </p>
          <CopyMessageButton
            getText={() => path}
            label="Copy path"
            className="h-11 w-11 shrink-0 sm:h-8 sm:w-8"
          />
        </div>
      </div>
      <div className="flex flex-col items-start gap-3 p-4">
        <p role={role} className="text-muted-foreground text-sm">
          {message}
        </p>
        {showReload && (
          <Button
            type="button"
            disabled={isFetching}
            onClick={() => {
              if (!isFetching) onReload();
            }}
          >
            <RefreshCw
              aria-hidden="true"
              className={isFetching ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            Reload saved file
          </Button>
        )}
      </div>
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
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const onReload = () => {
    setReloadGeneration(generation => generation + 1);
    void reload();
  };
  const statusProps = { path, isFetching, onReload };
  const showReload =
    !('file' in state) && (state.status === 'error' || (state.status === 'stale' && !isFetching));
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
          key={JSON.stringify([
            organizationId,
            cloudAgentSessionId,
            path,
            state.file.revision,
            reloadGeneration,
          ])}
          fallback={
            <FilePaneStatus
              {...statusProps}
              role="alert"
              showReload
              message="This saved file could not be rendered."
            />
          }
        >
          <Suspense
            fallback={<FilePaneStatus {...statusProps} message="Loading saved file viewer…" />}
          >
            <WorktreeFileRenderer
              file={state.file}
              mode={mode ?? 'diff'}
              onModeChange={onModeChange}
              review={reviewCapture ? review : undefined}
              reviewCapture={reviewCapture}
            />
          </Suspense>
        </RendererBoundary>
      ) : (
        <FilePaneStatus
          {...statusProps}
          role={state.status === 'error' ? 'alert' : 'status'}
          showReload={showReload}
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
