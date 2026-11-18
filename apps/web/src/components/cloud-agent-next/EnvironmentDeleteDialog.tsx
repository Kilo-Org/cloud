'use client';

import { useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
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

export function EnvironmentDeleteDialog({
  repositoryName,
  onDelete,
  isDeleting,
  disabled,
}: {
  repositoryName: string;
  onDelete: () => Promise<void>;
  isDeleting: boolean;
  disabled: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={next => {
        if (!isDeleting) {
          setError(null);
          setOpen(next);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          disabled={disabled}
        >
          <Trash2 className="mr-2 size-4" />
          Delete environment
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onOpenAutoFocus={event => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete environment?</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            This deletes the saved setup and variables for{' '}
            <span className="text-foreground font-medium">{repositoryName}</span>. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel ref={cancelRef} disabled={isDeleting}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="bg-destructive-hover hover:bg-destructive-hover/90"
            disabled={isDeleting}
            onClick={async () => {
              try {
                await onDelete();
                setOpen(false);
              } catch {
                setError('Could not delete the environment. Try again.');
              }
            }}
          >
            {isDeleting && <Loader2 className="mr-2 size-4 animate-spin" />}Delete environment
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
