'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrushCleaning, Check, LoaderCircle } from 'lucide-react';
import { formatSessionError } from '@kilocode/cloud-agent-sdk';
import { useTRPC } from '@/lib/trpc/utils';
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
import type { WorktreeCleanup } from './hooks/useWorktreeCleanup';

export function MergedWorktreeCleanup({
  organizationId,
  cleanup,
  statusError,
  statusLoading,
}: {
  organizationId?: string;
  cleanup: WorktreeCleanup | null | undefined;
  statusError: { message: string } | null;
  statusLoading: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const scope = { organizationId: organizationId ?? null };
  const preview = useQuery({
    ...trpc.cliSessionsV2.mergedWorktreeCleanupPreview.queryOptions(scope),
    enabled: open,
    staleTime: 0,
  });
  const start = useMutation(
    trpc.cliSessionsV2.startMergedWorktreeCleanup.mutationOptions({
      onSuccess: batch => {
        retry.reset();
        queryClient.setQueryData(trpc.cliSessionsV2.getWorktreeCleanup.queryKey(scope), batch);
        setOpen(false);
      },
    })
  );
  const retry = useMutation(
    trpc.cliSessionsV2.retryWorktreeCleanup.mutationOptions({
      onSuccess: batch => {
        queryClient.setQueryData(trpc.cliSessionsV2.getWorktreeCleanup.queryKey(scope), batch);
      },
    })
  );
  const active = cleanup?.items.some(
    item => item.status === 'pending' || item.status === 'deleting'
  );
  const deleted = cleanup?.items.filter(item => item.status === 'deleted').length ?? 0;
  const failed = cleanup?.items.filter(item => item.status === 'failed') ?? [];
  const count = preview.data?.worktreeIds.length ?? 0;

  return (
    <div className="border-b px-3 py-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-8 w-full justify-start px-2 text-xs [@media(any-pointer:coarse)]:min-h-11"
        disabled={statusLoading || active || start.isPending}
        onClick={() => {
          start.reset();
          setOpen(true);
        }}
      >
        {active ? (
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <BrushCleaning className="size-3.5" />
        )}
        {active ? 'Cleaning up merged workspaces...' : 'Clean up merged workspaces'}
      </Button>
      {cleanup && (
        <div className="px-2 pt-1 text-xs" role="status" aria-live="polite">
          <div className="text-muted-foreground flex items-center gap-1.5">
            {!active && failed.length === 0 && <Check className="size-3.5" />}
            <span className="tabular-nums">
              {deleted} of {cleanup.items.length} workspaces deleted
              {failed.length > 0 ? `, ${failed.length} failed` : ''}
            </span>
          </div>
          {active && <p className="text-muted-foreground mt-1">You can close this tab.</p>}
          {failed.length > 0 && (
            <>
              <details className="mt-1">
                <summary className="text-destructive cursor-pointer">View cleanup errors</summary>
                <ul className="text-muted-foreground mt-1 space-y-1 break-words">
                  {failed.map(item => (
                    <li key={item.worktreeId}>
                      {item.worktreeId}: {item.error}
                    </li>
                  ))}
                </ul>
              </details>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 h-8 text-xs [@media(any-pointer:coarse)]:min-h-11"
                disabled={active || retry.isPending}
                onClick={() => retry.mutate(scope)}
              >
                {retry.isPending ? 'Retrying...' : 'Retry failed cleanup'}
              </Button>
              {retry.error && (
                <p role="alert" className="text-destructive mt-1">
                  {formatSessionError(retry.error)}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {statusError && (
        <p role="alert" className="text-destructive px-2 pt-1 text-xs">
          Cleanup progress is unavailable. It will refresh automatically.
        </p>
      )}
      <AlertDialog open={open} onOpenChange={value => !start.isPending && setOpen(value)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean up merged workspaces?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview.isFetching
                ? 'Checking your workspaces for merged pull requests...'
                : count > 0
                  ? `Permanently delete ${count} workspace${count === 1 ? '' : 's'} with merged GitHub pull requests, including all chats and files, and stop any running work.`
                  : 'No workspaces with merged pull requests are ready for cleanup.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-muted-foreground text-sm">
            This checks all your workspaces in this account, regardless of sidebar filters.
            Workspaces with unmerged or unverified pull requests are kept. Cleanup continues in the
            background even if you close this tab.
          </p>
          {(preview.error || start.error) && (
            <p role="alert" className="text-destructive text-sm">
              {formatSessionError(start.error ?? preview.error)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={start.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={preview.isFetching || !!preview.error || count === 0 || start.isPending}
              onClick={() => {
                if (preview.data) start.mutate({ ...scope, worktreeIds: preview.data.worktreeIds });
              }}
            >
              {start.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {start.isPending
                ? 'Starting cleanup...'
                : `Delete ${count} workspace${count === 1 ? '' : 's'}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
