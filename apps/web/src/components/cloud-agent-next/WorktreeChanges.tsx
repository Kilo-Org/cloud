'use client';

import { useEffect, useMemo, useRef, type MouseEvent, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { ChevronRight, FileDiff, GitBranch, List, ListTree, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { useManager } from './CloudAgentProvider';
import {
  buildWorktreeChangesTree,
  createWorktreeChangesRefresher,
  deserializeWorktreeChangesViewMode,
  formatWorktreeChangesBaseBranch,
  getWorktreeChangesTotals,
  groupWorktreeChangesByDirectory,
  preserveNewerWorktreeChanges,
  worktreeChangesMessages,
  type WorktreeChangesFile,
  type WorktreeChangesTreeNode,
  type WorktreeChangesViewMode,
} from './worktree-changes';

const fileStatusStyles = {
  added: { label: 'Added', dot: 'bg-diff-add-text' },
  modified: { label: 'Modified', dot: 'bg-(--status-orange-400)' },
  deleted: { label: 'Deleted', dot: 'bg-diff-delete-text' },
};
const compactCountFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 0,
});

function useSavedWorktreeChanges({
  cloudAgentSessionId,
  organizationId,
  enabled,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  enabled: boolean;
}) {
  const trpc = useTRPC();
  const queryOptions = useMemo(
    () =>
      organizationId
        ? trpc.organizations.cloudAgentNext.getWorktreeChanges.queryOptions(
            { organizationId, cloudAgentSessionId },
            { trpc: { abortOnUnmount: true, context: { skipBatch: true } } }
          )
        : trpc.cloudAgentNext.getWorktreeChanges.queryOptions(
            { cloudAgentSessionId },
            { trpc: { abortOnUnmount: true, context: { skipBatch: true } } }
          ),
    [trpc, organizationId, cloudAgentSessionId]
  );
  const saved = useQuery({
    ...queryOptions,
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      const status = error.data?.httpStatus;
      return (
        failureCount < 2 &&
        (status === undefined || status === 408 || status === 429 || status >= 500)
      );
    },
    structuralSharing: preserveNewerWorktreeChanges,
  });
  return { saved, queryKey: queryOptions.queryKey };
}

function ChangeLineCounts({
  additions,
  deletions,
  countsComplete,
  compactOnMobile = false,
}: Pick<WorktreeChangesFile, 'additions' | 'deletions' | 'countsComplete'> & {
  compactOnMobile?: boolean;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 font-mono tabular-nums ${compactOnMobile ? 'text-[11px] sm:text-xs' : 'text-xs'}`}
      title={countsComplete ? undefined : 'Partial line counts'}
    >
      <span className="text-diff-add-text" aria-label={`${additions} additions`}>
        {compactOnMobile && (
          <span className="sm:hidden">+{compactCountFormatter.format(additions)}</span>
        )}
        <span className={compactOnMobile ? 'hidden sm:inline' : undefined}>+{additions}</span>
      </span>
      <span className="text-diff-delete-text" aria-label={`${deletions} deletions`}>
        {compactOnMobile && (
          <span className="sm:hidden">−{compactCountFormatter.format(deletions)}</span>
        )}
        <span className={compactOnMobile ? 'hidden sm:inline' : undefined}>−{deletions}</span>
      </span>
      {!countsComplete && (
        <span className="text-muted-foreground" aria-label="Partial line counts">
          *
        </span>
      )}
    </span>
  );
}

export function WorktreeChangesButton({
  cloudAgentSessionId,
  organizationId,
  open,
  onToggle,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  open: boolean;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const manager = useManager();
  const refreshSignal = useAtomValue(manager.atoms.worktreeChangesRefresh);
  const queryClient = useQueryClient();
  const { saved, queryKey } = useSavedWorktreeChanges({
    cloudAgentSessionId,
    organizationId,
    enabled: true,
  });
  const handledSignal = useRef(refreshSignal);
  const refresher = useRef<ReturnType<typeof createWorktreeChangesRefresher> | null>(null);
  useEffect(() => {
    const current = createWorktreeChangesRefresher(queryClient, queryKey);
    refresher.current = current;
    return () => {
      current.dispose();
      refresher.current = null;
    };
  }, [queryClient, queryKey]);
  useEffect(() => {
    const previous = handledSignal.current;
    if (previous === refreshSignal) return;
    handledSignal.current = refreshSignal;
    if (refreshSignal?.cloudSessionId !== cloudAgentSessionId) return;
    const reconnected =
      previous?.cloudSessionId !== refreshSignal.cloudSessionId ||
      previous?.connectionVersion !== refreshSignal.connectionVersion;
    const cached = queryClient.getQueryData<typeof saved.data>(queryKey);
    if (
      !reconnected &&
      refreshSignal.revision !== undefined &&
      (cached?.snapshot?.revision ?? 0) >= refreshSignal.revision
    )
      return;
    void refresher.current?.request({
      revision: refreshSignal.revision ?? 0,
      force: reconnected,
    });
  }, [refreshSignal, cloudAgentSessionId, queryClient, queryKey]);

  const totals = getWorktreeChangesTotals(saved.data?.snapshot);
  const summary = totals
    ? `${totals.fileCount} changed files, ${totals.additions} additions, ${totals.deletions} deletions${totals.countsComplete ? '' : ' (partial summary)'}`
    : 'Changes';

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="aria-expanded:bg-secondary h-11 min-w-11 shrink-0 gap-1.5 px-2 font-mono text-xs tabular-nums sm:h-8 sm:min-w-8"
      aria-label="Changes"
      aria-description={totals ? summary : undefined}
      title={totals ? `Saved changes: ${summary}` : 'Changes'}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? 'worktree-changes-panel' : undefined}
      onClick={onToggle}
    >
      <FileDiff className={totals ? 'hidden size-4 sm:block' : 'size-4'} aria-hidden="true" />
      {totals && (
        <>
          <span className="text-muted-foreground hidden sm:inline">{totals.fileCount}f</span>
          <ChangeLineCounts {...totals} compactOnMobile />
        </>
      )}
    </Button>
  );
}

export function WorktreeChangesDrawer({
  cloudAgentSessionId,
  organizationId,
  open,
  onOpenChange,
  onCloseAutoFocus,
  portalContainer,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  portalContainer: HTMLElement | null;
}) {
  const [viewMode, setViewMode] = useLocalStorage<WorktreeChangesViewMode>(
    'cloud-agent:worktree-changes-view-mode',
    'flat',
    { initializeWithValue: false, deserializer: deserializeWorktreeChangesViewMode }
  );
  const activeTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) activeTabRef.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id="worktree-changes-panel"
        side="right"
        portalContainer={portalContainer}
        overlayClassName="absolute"
        dismissibleOverlay
        showCloseButton={false}
        className="absolute inset-y-0 right-0 h-full w-full gap-0 border-l p-0 motion-reduce:animate-none! motion-reduce:transition-none sm:max-w-md"
        onOpenAutoFocus={event => {
          event.preventDefault();
          activeTabRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        onInteractOutside={event => event.preventDefault()}
      >
        <SheetTitle className="sr-only">Changes</SheetTitle>
        <SheetDescription className="sr-only">
          Changed files in the session worktree.
        </SheetDescription>
        <WorktreeChanges
          cloudAgentSessionId={cloudAgentSessionId}
          organizationId={organizationId}
          open={open}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          activeTabRef={activeTabRef}
        />
      </SheetContent>
    </Sheet>
  );
}

function ChangedFile({ file }: { file: WorktreeChangesFile }) {
  const status = fileStatusStyles[file.status];
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);

  return (
    <li className="hover:bg-muted/50 flex h-7 min-w-0 items-center gap-2 rounded-sm px-2 text-xs">
      <span
        role="img"
        aria-label={`${status.label}${file.tracked ? '' : ', untracked'}`}
        className={`mx-1 size-1.5 shrink-0 rounded-full ${status.dot}`}
      />
      <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
        {name}
      </span>
      {file.binary ? (
        <span className="sr-only">Binary file; line counts unavailable.</span>
      ) : (
        <ChangeLineCounts
          additions={file.additions}
          deletions={file.deletions}
          countsComplete={file.countsComplete}
        />
      )}
    </li>
  );
}

function ChangedFileTree({ nodes }: { nodes: WorktreeChangesTreeNode[] }) {
  return nodes.map(node =>
    node.kind === 'file' ? (
      <ChangedFile key={`file:${node.path}`} file={node.file} />
    ) : (
      <Collapsible key={`directory:${node.path}`} asChild defaultOpen>
        <li className="min-w-0">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group h-11 w-full justify-start gap-2 rounded-sm px-2 py-0 font-mono text-xs font-normal sm:h-7"
              title={node.path}
            >
              <ChevronRight
                aria-hidden="true"
                className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
              />
              <span className="min-w-0 truncate">{node.name}</span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="ml-4">
              <ChangedFileTree nodes={node.children} />
            </ul>
          </CollapsibleContent>
        </li>
      </Collapsible>
    )
  );
}

function WorktreeChanges({
  cloudAgentSessionId,
  organizationId,
  open,
  viewMode,
  onViewModeChange,
  activeTabRef,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  open: boolean;
  viewMode: WorktreeChangesViewMode;
  onViewModeChange: (value: WorktreeChangesViewMode) => void;
  activeTabRef: RefObject<HTMLButtonElement | null>;
}) {
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const { saved, queryKey } = useSavedWorktreeChanges({
    cloudAgentSessionId,
    organizationId,
    enabled: open,
  });
  const refresh = useMutation({
    mutationFn: () =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.refreshWorktreeChanges.mutate({
            organizationId,
            cloudAgentSessionId,
          })
        : trpcClient.cloudAgentNext.refreshWorktreeChanges.mutate({ cloudAgentSessionId }),
    onSuccess: result => {
      queryClient.setQueryData(queryKey, previous =>
        preserveNewerWorktreeChanges(previous, { snapshot: result.snapshot })
      );
    },
    retry: false,
  });
  const attemptedOpeningRefresh = useRef(false);
  const { mutate } = refresh;
  useEffect(() => {
    if (!open) {
      attemptedOpeningRefresh.current = false;
      return;
    }
    if (!saved.isFetchedAfterMount || saved.isFetching || attemptedOpeningRefresh.current) return;
    attemptedOpeningRefresh.current = true;
    mutate();
  }, [open, saved.isFetchedAfterMount, saved.isFetching, mutate]);

  const snapshot = saved.data?.snapshot;
  const groups = useMemo(
    () => groupWorktreeChangesByDirectory(snapshot?.files ?? []),
    [snapshot?.files]
  );
  const tree = useMemo(() => buildWorktreeChangesTree(snapshot?.files ?? []), [snapshot?.files]);
  const messages = worktreeChangesMessages({
    snapshot,
    savedReadPending: saved.isPending,
    savedReadFailed: saved.isError,
    refreshPending: refresh.isPending,
    refreshFailed: refresh.isError,
    refreshStatus: refresh.data?.status,
  });

  return (
    <Tabs
      value={viewMode}
      onValueChange={value => onViewModeChange(value === 'tree' ? 'tree' : 'flat')}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1">
        <TabsList aria-label="File layout" className="h-auto p-0.5 sm:h-8">
          <TabsTrigger
            ref={viewMode === 'flat' ? activeTabRef : undefined}
            value="flat"
            className="h-11 gap-1.5 px-2 text-xs sm:h-7"
          >
            <List aria-hidden="true" className="size-3.5" />
            Flat
          </TabsTrigger>
          <TabsTrigger
            ref={viewMode === 'tree' ? activeTabRef : undefined}
            value="tree"
            className="h-11 gap-1.5 px-2 text-xs sm:h-7"
          >
            <ListTree aria-hidden="true" className="size-3.5" />
            Tree
          </TabsTrigger>
        </TabsList>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh changes"
          title="Refresh changes"
          disabled={saved.isFetching || refresh.isPending}
          onClick={() => mutate()}
          className="h-11 w-11 shrink-0 sm:h-8 sm:w-8"
        >
          <RefreshCw
            aria-hidden="true"
            className={`size-3.5 ${refresh.isPending ? 'animate-spin motion-reduce:animate-none' : ''}`}
          />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {messages.empty && (
          <p role="status" className="text-muted-foreground px-2 py-3 text-xs">
            {messages.empty}
          </p>
        )}
        <TabsContent value="flat" className="m-0">
          {groups.length > 0 && (
            <ul aria-label="Changed files" className="space-y-2">
              {groups.map(({ directory, files }) => (
                <li key={directory}>
                  <h3 className="text-muted-foreground flex min-w-0 items-center gap-2 px-2 py-1 text-xs font-normal">
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={directory || 'Repository root'}
                    >
                      {directory || 'Repository root'}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">{files.length}</span>
                  </h3>
                  <ul aria-label={`Files in ${directory || 'repository root'}`}>
                    {files.map(file => (
                      <ChangedFile key={file.path} file={file} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="tree" className="m-0">
          {tree.length > 0 && (
            <ul aria-label="Changed files">
              <ChangedFileTree nodes={tree} />
            </ul>
          )}
        </TabsContent>
      </div>

      {(snapshot || messages.notice) && (
        <div className="text-muted-foreground shrink-0 space-y-1 border-t px-3 py-2 text-xs">
          {snapshot && (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch aria-hidden="true" className="size-3 shrink-0" />
              <code
                className="min-w-0 flex-1 truncate"
                title={`Working tree changes since the merge base with ${snapshot.comparison.baseRef}.\nCaptured HEAD: ${snapshot.comparison.head}\nMerge base: ${snapshot.comparison.mergeBase}`}
              >
                Working tree → {formatWorktreeChangesBaseBranch(snapshot.comparison.baseRef)}
              </code>
              <time
                className="shrink-0 whitespace-nowrap"
                dateTime={snapshot.capturedAt}
                title={`Last saved ${new Date(snapshot.capturedAt).toLocaleString()}`}
              >
                {formatDistanceToNow(new Date(snapshot.capturedAt), { addSuffix: true })}
              </time>
            </div>
          )}
          <div role="status" aria-live="polite">
            {messages.notice && <p>{messages.notice}</p>}
            {snapshot?.truncated && <p>Partial summary · some files omitted.</p>}
          </div>
        </div>
      )}
    </Tabs>
  );
}
