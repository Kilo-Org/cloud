'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Archive, CloudOff, Download, FileText, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  workspaceArtifactExpiresAt,
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
}: {
  userId: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  open: boolean;
  readOnly: boolean;
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

  if (!open) return null;

  const status = sandboxStatus.data?.status;
  const sandboxNotRunning = isSandboxNotRunning(status);

  return (
    <div
      id="workspace-artifacts-panel"
      className="bg-background text-foreground flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-medium">Artifacts</h2>
          <p className="text-muted-foreground truncate text-[11px]">Saved from /artifacts</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh artifacts"
          title="Refresh artifacts"
          disabled={list.isFetching}
          onClick={() => {
            void list.refetch();
            void sandboxStatus.refetch();
          }}
          className="h-11 w-11 shrink-0 sm:h-8 sm:w-8"
        >
          <RefreshCw
            aria-hidden="true"
            className={`size-3.5 ${list.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`}
          />
        </Button>
      </div>

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
              {group.files.map(entry => {
                const expiresAt = workspaceArtifactExpiresAt(entry);
                return (
                  <li
                    key={entry.relativePath}
                    className="hover:bg-secondary/60 flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5"
                  >
                    <FileText
                      aria-hidden="true"
                      className="text-muted-foreground size-3.5 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="min-w-0 truncate font-mono text-xs" title={entry.relativePath}>
                        {workspaceArtifactFileName(entry)}
                        <span className="sr-only"> {entry.relativePath}</span>
                      </p>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                        <span>{formatWorkspaceArtifactSize(entry.sizeBytes)}</span>
                        <span className="sm:border-border sm:border-l sm:pl-2">
                          Synced{' '}
                          <time dateTime={new Date(entry.updatedAt).toISOString()}>
                            {formatDistanceToNow(new Date(entry.updatedAt), {
                              addSuffix: true,
                            })}
                          </time>
                        </span>
                        <span className="sm:border-border sm:border-l sm:pl-2">
                          Expires{' '}
                          <time dateTime={new Date(expiresAt).toISOString()}>
                            {formatDistanceToNow(new Date(expiresAt), { addSuffix: true })}
                          </time>
                        </span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 shrink-0 sm:h-8 sm:w-8"
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
                        className="text-muted-foreground hover:text-destructive h-11 w-11 shrink-0 sm:h-8 sm:w-8"
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
                );
              })}
            </ul>
          </section>
        ))}
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
    </div>
  );
}
