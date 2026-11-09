'use client';

import { useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';

/**
 * The recovery action for a workspace snapshot whose start failed permanently.
 * It appears only when the workspace still has a snapshot to discard, and it
 * names the capture time so the user can see which changes starting fresh
 * would lose.
 */
export function WorkspaceSnapshotRecovery({
  capturedAt,
  onRemove,
  isRemoving,
}: {
  capturedAt: number | null;
  onRemove: () => Promise<void>;
  isRemoving: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capturedLabel =
    capturedAt === null
      ? null
      : new Date(capturedAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });

  return (
    <AlertDialog
      open={open}
      onOpenChange={next => {
        if (!isRemoving) {
          setError(null);
          setOpen(next);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="mt-2">
          <RotateCcw className="mr-2 size-4" />
          Start fresh
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onOpenAutoFocus={event => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Start fresh?</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            {capturedLabel === null ? (
              <>
                The saved workspace snapshot is unreadable and cannot start this session. Starting
                fresh discards it and every workspace change it holds;
              </>
            ) : (
              <>
                The workspace snapshot captured{' '}
                <span className="text-foreground font-medium">{capturedLabel}</span> cannot start
                this session. Starting fresh discards every workspace change made since then;
              </>
            )}{' '}
            your next start uses the environment snapshot or the base image instead. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel ref={cancelRef} disabled={isRemoving}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="bg-destructive-hover hover:bg-destructive-hover/90"
            disabled={isRemoving}
            onClick={async () => {
              try {
                await onRemove();
                setOpen(false);
              } catch {
                setError('Could not remove the workspace snapshot. Try again.');
              }
            }}
          >
            {isRemoving && <Loader2 className="mr-2 size-4 animate-spin" />}
            Start fresh
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
