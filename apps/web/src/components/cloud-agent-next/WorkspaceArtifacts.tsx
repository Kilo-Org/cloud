'use client';

import { useEffect, useState, type ComponentProps, type MouseEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, CloudOff, Download, FileText, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import type { WorkspaceArtifactEntry } from '@kilocode/worker-utils/cloud-agent-workspace-artifacts';
import { useWorkspaceArtifacts } from './useWorkspaceArtifacts';
import {
  formatWorkspaceArtifactSize,
  groupWorkspaceArtifactsByFolder,
  isSandboxNotRunning,
  workspaceArtifactFileName,
} from './workspace-artifacts';

function artifactCountLabel(count: number) {
  return `${count} ${count === 1 ? 'artifact' : 'artifacts'}`;
}

export function WorkspaceArtifactsButton({
  userId,
  cloudAgentSessionId,
  organizationId,
  open,
  onToggle,
}: {
  userId: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  open: boolean;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { list } = useWorkspaceArtifacts({
    userId,
    cloudAgentSessionId,
    organizationId,
    enabled: true,
    sandboxStatusEnabled: false,
  });
  const entries = list.data?.entries ?? [];
  const totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  const summary = entries.length
    ? `${artifactCountLabel(entries.length)}, ${formatWorkspaceArtifactSize(totalBytes)} saved`
    : 'Saved artifacts';

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="aria-expanded:bg-secondary h-11 min-w-11 shrink-0 gap-1.5 px-2 font-mono text-xs tabular-nums sm:h-8 sm:min-w-8"
      aria-label="Artifacts"
      aria-description={entries.length ? summary : undefined}
      title={summary}
      aria-expanded={open}
      aria-controls={open ? 'workspace-artifacts-panel' : undefined}
      onClick={onToggle}
    >
      <Archive className="size-4" aria-hidden="true" />
      {entries.length > 0 && (
        <span className="text-muted-foreground hidden sm:inline">{entries.length}</span>
      )}
    </Button>
  );
}

export function WorkspaceArtifactsView({
  userId,
  cloudAgentSessionId,
  organizationId,
  open,
  readOnly,
  onOpenChange,
  onCloseAutoFocus,
  portalContainer,
}: {
  userId: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  open: boolean;
  readOnly: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof SheetContent>['onCloseAutoFocus'];
  portalContainer?: HTMLElement | null;
}) {
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const { list, sandboxStatus, queryKey } = useWorkspaceArtifacts({
    userId,
    cloudAgentSessionId,
    organizationId,
    enabled: open,
  });
  const [pendingDelete, setPendingDelete] = useState<WorkspaceArtifactEntry | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const entries = list.data?.entries ?? [];
  const groups = groupWorkspaceArtifactsByFolder(entries);

  useEffect(() => {
    if (!open) return;
    void list.refetch();
    void sandboxStatus.refetch();
  }, [open, list.refetch, sandboxStatus.refetch]);

  const download = useMutation({
    mutationFn: (entry: WorkspaceArtifactEntry) =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.getWorkspaceArtifactDownloadUrl.query({
            organizationId,
            cloudAgentSessionId,
            relativePath: entry.relativePath,
          })
        : trpcClient.cloudAgentNext.getWorkspaceArtifactDownloadUrl.query({
            cloudAgentSessionId,
            relativePath: entry.relativePath,
          }),
    onSuccess: ({ url }) => {
      setFeedback(null);
      window.location.assign(url);
    },
    onError: (_error, entry) => {
      setFeedback(
        `Could not create a download link for ${workspaceArtifactFileName(entry)}. Refresh and try again.`
      );
    },
    retry: false,
  });

  const remove = useMutation({
    mutationFn: (entry: WorkspaceArtifactEntry) =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.deleteWorkspaceArtifact.mutate({
            organizationId,
            cloudAgentSessionId,
            relativePath: entry.relativePath,
            expectedHash: entry.contentHash,
          })
        : trpcClient.cloudAgentNext.deleteWorkspaceArtifact.mutate({
            cloudAgentSessionId,
            relativePath: entry.relativePath,
            expectedHash: entry.contentHash,
          }),
    onSuccess: (result, entry) => {
      setPendingDelete(null);
      setFeedback(
        result.status === 'hash_mismatch'
          ? `${workspaceArtifactFileName(entry)} changed since this list loaded. The list has been refreshed; review the new version and try again.`
          : null
      );
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (_error, entry) => {
      setPendingDelete(null);
      setFeedback(`Could not delete ${workspaceArtifactFileName(entry)}. Try again.`);
    },
    retry: false,
  });

  const status = sandboxStatus.data?.status;
  const sandboxNotRunning = isSandboxNotRunning(status);

  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id="workspace-artifacts-panel"
        side="right"
        portalContainer={portalContainer}
        overlayClassName="absolute"
        dismissibleOverlay
        showCloseButton={false}
        aria-describedby={undefined}
        className="absolute inset-y-0 right-0 h-full w-full gap-0 border-l p-0 sm:max-w-xl lg:max-w-2xl"
        onCloseAutoFocus={onCloseAutoFocus}
        onInteractOutside={event => event.preventDefault()}
      >
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-4 py-2">
          <SheetTitle className="text-base">Artifacts</SheetTitle>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 sm:size-8"
              aria-label="Close artifacts"
              title="Close artifacts"
            >
              <X aria-hidden="true" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sandboxNotRunning && (
            <div
              role="status"
              className="border-border bg-muted/40 text-muted-foreground mb-3 flex items-start gap-2 rounded-md border p-2 text-xs"
            >
              <CloudOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <p>
                The sandbox is not running. Saved files remain available, but new changes are not
                syncing.
              </p>
            </div>
          )}

          {feedback && (
            <p
              role="alert"
              aria-live="polite"
              className="border-border bg-muted/40 text-foreground mb-3 rounded-md border p-2 text-xs"
            >
              {feedback}
            </p>
          )}

          {list.isPending && (
            <p role="status" className="text-muted-foreground px-2 py-3 text-xs">
              Loading artifacts…
            </p>
          )}

          {list.isError && entries.length === 0 && (
            <div className="flex flex-col items-start gap-2 px-2 py-3">
              <p role="alert" className="text-muted-foreground text-xs">
                Could not load artifacts.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
                Retry
              </Button>
            </div>
          )}

          {!list.isPending && !list.isError && entries.length === 0 && (
            <p role="status" className="text-muted-foreground px-2 py-3 text-xs">
              No saved artifacts yet. Files saved in /artifacts appear here after synchronization.
            </p>
          )}

          {groups.map(group => (
            <section key={group.directory} aria-label={group.label} className="mb-3">
              <h3
                className="text-muted-foreground flex min-w-0 items-center gap-2 px-2 py-1 text-xs font-normal"
                title={group.directory || 'Artifacts'}
              >
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                <span className="shrink-0 font-mono tabular-nums">{group.files.length}</span>
              </h3>
              <ul aria-label={`Artifacts in ${group.label}`}>
                {group.files.map(entry => (
                  <li
                    key={entry.relativePath}
                    className="hover:bg-secondary/60 flex min-w-0 items-center gap-2 rounded-sm px-2"
                  >
                    <FileText
                      aria-hidden="true"
                      className="text-muted-foreground size-3.5 shrink-0"
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                      title={entry.relativePath}
                    >
                      {workspaceArtifactFileName(entry)}
                      <span className="sr-only"> {entry.relativePath}</span>
                    </span>
                    <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                      {formatWorkspaceArtifactSize(entry.sizeBytes)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 sm:size-8"
                      aria-label={`Download ${entry.relativePath}`}
                      title={`Download ${entry.relativePath}`}
                      disabled={download.isPending}
                      onClick={() => download.mutate(entry)}
                    >
                      <Download aria-hidden="true" className="size-3.5" />
                    </Button>
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive size-11 shrink-0 sm:size-8"
                        aria-label={`Delete ${entry.relativePath}`}
                        title={`Delete ${entry.relativePath}`}
                        onClick={() => {
                          setFeedback(null);
                          setPendingDelete(entry);
                        }}
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-4 py-2">
          <p className="text-muted-foreground text-xs">
            Kept until the workspace or standalone session is deleted.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 shrink-0 sm:h-8"
            disabled={list.isFetching}
            onClick={() => {
              void list.refetch();
              void sandboxStatus.refetch();
            }}
          >
            <RefreshCw
              aria-hidden="true"
              className={list.isFetching ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            Refresh
          </Button>
        </div>

        <AlertDialog
          open={pendingDelete !== null}
          onOpenChange={open => {
            if (!open && !remove.isPending) setPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {pendingDelete ? workspaceArtifactFileName(pendingDelete) : 'artifact'}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This removes the file from your artifacts. A copy may remain in a running sandbox.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={remove.isPending || pendingDelete === null}
                onClick={() => {
                  if (pendingDelete) remove.mutate(pendingDelete);
                }}
              >
                Delete artifact
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
