'use client';

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import {
  ArrowLeft,
  ChevronRight,
  FileDiff,
  GitBranch,
  List,
  ListTree,
  MessageSquareText,
  RefreshCw,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useResizableSidebar } from '@/hooks/useResizableSidebar';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import { useManager } from './CloudAgentProvider';
import { WorktreeFilePane } from './WorktreeFilePane';
import { useSavedWorktreeChanges } from './useSavedWorktreeChanges';
import type { WorktreeFileReviewBindings } from './worktree-review-bindings';
import type { WorktreeFileViewMode } from './workspace-tabs';
import {
  buildWorktreeChangesTree,
  createWorktreeChangesRefresher,
  deserializeWorktreeChangesViewMode,
  formatWorktreeChangesBaseBranch,
  getWorktreeChangesTotals,
  getWorktreeChangesFileKey,
  groupWorktreeChangesByDirectory,
  groupWorktreeChangesByScope,
  preserveNewerWorktreeChanges,
  resolveWorktreeChangesSelection,
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
  worktreeId,
  open,
  onToggle,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  worktreeId?: string;
  open: boolean;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const manager = useManager();
  const refreshSignal = useAtomValue(manager.atoms.worktreeChangesRefresh);
  const queryClient = useQueryClient();
  const { saved, queryKey } = useSavedWorktreeChanges({
    cloudAgentSessionId,
    organizationId,
    worktreeId,
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

  const snapshotTotals = getWorktreeChangesTotals(saved.data?.snapshot);
  // A clean worktree keeps the plain icon instead of a row of zero counts.
  const totals = snapshotTotals && snapshotTotals.fileCount > 0 ? snapshotTotals : null;
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

export function WorktreeChangesView({
  cloudAgentSessionId,
  organizationId,
  worktreeId,
  open,
  commentCounts,
  review,
  reviewScope,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  worktreeId?: string;
  open: boolean;
  commentCounts?: ReadonlyMap<string, number>;
  review?: WorktreeFileReviewBindings;
  reviewScope?: { userId: string; organizationId?: string; workspaceScope: string };
}) {
  const [viewMode, setViewMode] = useLocalStorage<WorktreeChangesViewMode>(
    'cloud-agent:worktree-changes-view-mode',
    'flat',
    { initializeWithValue: false, deserializer: deserializeWorktreeChangesViewMode }
  );
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const { saved } = useSavedWorktreeChanges({
    cloudAgentSessionId,
    organizationId,
    worktreeId,
    enabled: open,
  });
  const files = saved.data?.snapshot?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = resolveWorktreeChangesSelection(selectedPath, files);
  const selectedFile = files.find(file => getWorktreeChangesFileKey(file) === selected);
  if (selected !== selectedPath) setSelectedPath(selected);
  const [mode, setMode] = useState<WorktreeFileViewMode>('diff');
  const [mobilePane, setMobilePane] = useState<'list' | 'diff'>('list');
  const { width: listWidth, startDrag } = useResizableSidebar(
    448,
    200,
    640,
    'cloud-agent:worktree-changes-list-width'
  );

  useEffect(() => {
    setMode('diff');
  }, [selected]);

  useEffect(() => {
    if (!open) setMobilePane('list');
  }, [open]);

  useEffect(() => {
    if (open) activeTabRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  const showDiff = mobilePane === 'diff' && selected !== null;

  return (
    <div
      id="worktree-changes-panel"
      className="bg-background text-foreground flex min-h-0 min-w-0 flex-1"
    >
      <div
        className={`${showDiff ? 'hidden' : 'flex'} w-full min-h-0 flex-col sm:flex sm:w-(--worktree-list-width) sm:shrink-0`}
        style={{ '--worktree-list-width': `${listWidth}px` } as CSSProperties}
      >
        <WorktreeChanges
          cloudAgentSessionId={cloudAgentSessionId}
          organizationId={organizationId}
          worktreeId={worktreeId}
          open={open}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          activePath={selected ?? undefined}
          onSelectFile={path => {
            setSelectedPath(path);
            setMobilePane('diff');
          }}
          activeTabRef={activeTabRef}
          commentCounts={commentCounts}
        />
      </div>
      <div
        className="before:bg-border hover:before:bg-border relative hidden w-3 shrink-0 cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:content-[''] sm:block"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file list"
        onMouseDown={startDrag}
      />
      <div className={`${showDiff ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col sm:flex`}>
        <div className="shrink-0 border-b p-1 sm:hidden">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Back to changed files"
            className="h-11 gap-1.5 px-2 text-xs"
            onClick={() => setMobilePane('list')}
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Back
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {selectedFile ? (
            <WorktreeFilePane
              cloudAgentSessionId={cloudAgentSessionId}
              organizationId={organizationId}
              worktreeId={worktreeId}
              path={selectedFile.path}
              scope={selectedFile.scope}
              mode={mode}
              onModeChange={setMode}
              review={review}
              reviewScope={reviewScope}
            />
          ) : (
            <p className="text-muted-foreground p-3 text-xs">No changed files.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ChangedFile({
  file,
  onSelectFile,
  commentCount = 0,
  active = false,
}: {
  file: WorktreeChangesFile;
  onSelectFile: (path: string) => void;
  commentCount?: number;
  active?: boolean;
}) {
  const status = fileStatusStyles[file.status];
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);

  return (
    <li className="min-w-0">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`h-11 w-full min-w-0 justify-start gap-2 rounded-sm px-2 py-0 text-xs font-normal sm:h-7 ${active ? 'bg-secondary' : ''}`}
        title={file.path}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelectFile(getWorktreeChangesFileKey(file))}
      >
        <span
          role="img"
          aria-label={`${status.label}${file.tracked ? '' : ', untracked'}`}
          className={`mx-1 size-1.5 shrink-0 rounded-full ${status.dot}`}
        />
        <span className="min-w-0 flex-1 truncate text-left font-mono" aria-hidden="true">
          {name}
        </span>
        <span className="sr-only">{file.path}</span>
        {commentCount > 0 && (
          <span
            className="text-muted-foreground inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums"
            aria-label={`${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`}
          >
            <MessageSquareText className="size-3" aria-hidden="true" />
            {commentCount}
          </span>
        )}
        {file.binary ? (
          <span className="sr-only">Binary file; line counts unavailable.</span>
        ) : (
          <ChangeLineCounts
            additions={file.additions}
            deletions={file.deletions}
            countsComplete={file.countsComplete}
          />
        )}
      </Button>
    </li>
  );
}

function ChangedFileTree({
  nodes,
  onSelectFile,
  activePath,
  commentCounts,
}: {
  nodes: WorktreeChangesTreeNode[];
  onSelectFile: (path: string) => void;
  activePath?: string;
  commentCounts?: ReadonlyMap<string, number>;
}) {
  return nodes.map(node =>
    node.kind === 'file' ? (
      <ChangedFile
        key={`file:${node.path}`}
        file={node.file}
        onSelectFile={onSelectFile}
        active={getWorktreeChangesFileKey(node.file) === activePath}
        commentCount={commentCounts?.get(getWorktreeChangesFileKey(node.file)) ?? 0}
      />
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
              <ChangedFileTree
                nodes={node.children}
                onSelectFile={onSelectFile}
                activePath={activePath}
                commentCounts={commentCounts}
              />
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
  worktreeId,
  open,
  viewMode,
  onViewModeChange,
  onSelectFile,
  activePath,
  activeTabRef,
  commentCounts,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  worktreeId?: string;
  open: boolean;
  viewMode: WorktreeChangesViewMode;
  onViewModeChange: (value: WorktreeChangesViewMode) => void;
  onSelectFile: (path: string) => void;
  activePath?: string;
  activeTabRef: RefObject<HTMLButtonElement | null>;
  commentCounts?: ReadonlyMap<string, number>;
}) {
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const { saved, queryKey } = useSavedWorktreeChanges({
    cloudAgentSessionId,
    organizationId,
    worktreeId,
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
  const sections = groupWorktreeChangesByScope(snapshot?.files ?? []);
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
        {(['flat', 'tree'] as const).map(layout => (
          <TabsContent key={layout} value={layout} className="m-0">
            {snapshot &&
              sections.map(section => {
                const groups =
                  layout === 'flat' ? groupWorktreeChangesByDirectory(section.files) : [];
                const tree = layout === 'tree' ? buildWorktreeChangesTree(section.files) : [];
                return (
                  <section key={section.label} aria-label={section.label} className="mb-3">
                    <h2 className="flex items-center justify-between gap-2 px-2 py-2 text-xs font-medium">
                      {section.label}
                      <span className="text-muted-foreground font-mono tabular-nums">
                        {section.files.length}
                      </span>
                    </h2>
                    {section.files.length === 0 && snapshot.files.length > 0 && (
                      <p className="text-muted-foreground px-2 pb-2 text-xs">No changes.</p>
                    )}
                    {layout === 'flat' && groups.length > 0 && (
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
                              <span className="shrink-0 font-mono tabular-nums">
                                {files.length}
                              </span>
                            </h3>
                            <ul aria-label={`Files in ${directory || 'repository root'}`}>
                              {files.map(file => (
                                <ChangedFile
                                  key={file.path}
                                  file={file}
                                  onSelectFile={onSelectFile}
                                  active={getWorktreeChangesFileKey(file) === activePath}
                                  commentCount={
                                    commentCounts?.get(getWorktreeChangesFileKey(file)) ?? 0
                                  }
                                />
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    )}
                    {layout === 'tree' && tree.length > 0 && (
                      <ul aria-label="Changed files">
                        <ChangedFileTree
                          nodes={tree}
                          onSelectFile={onSelectFile}
                          activePath={activePath}
                          commentCounts={commentCounts}
                        />
                      </ul>
                    )}
                  </section>
                );
              })}
          </TabsContent>
        ))}
      </div>

      {(snapshot || messages.notice) && (
        <div className="text-muted-foreground shrink-0 space-y-1 border-t px-3 py-2 text-xs">
          {snapshot && (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch aria-hidden="true" className="size-3 shrink-0" />
              <code
                className="min-w-0 flex-1 truncate"
                title={`Uncommitted changes against HEAD and committed changes since the merge base with ${snapshot.comparison.baseRef}.\nCaptured HEAD: ${snapshot.comparison.head}\nMerge base: ${snapshot.comparison.mergeBase}`}
              >
                Base branch: {formatWorktreeChangesBaseBranch(snapshot.comparison.baseRef)}
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
