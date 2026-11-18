'use client';

import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useTRPC } from '@/lib/trpc/utils';

export function ReleaseEmailAddressButton({ userId, email }: { userId: string; email: string }) {
  const [open, setOpen] = useState(false);
  const trpc = useTRPC();
  const router = useRouter();
  const releaseEmailAddress = useMutation(
    trpc.admin.users.releaseEmailAddress.mutationOptions({
      onSuccess: () => {
        toast.success('Email address released');
        setOpen(false);
        router.refresh();
      },
      onError: error => {
        toast.error('Could not release email address', { description: error.message });
      },
    })
  );
  const isPending = releaseEmailAddress.isPending;

  function handleOpenChange(nextOpen: boolean) {
    if (!isPending) setOpen(nextOpen);
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive" disabled={isPending}>
          Release email address
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Release email address</AlertDialogTitle>
          <AlertDialogDescription>
            Release <span className="font-mono break-all text-foreground">{email}</span> from
            account <span className="font-mono break-all text-foreground">{userId}</span>? This
            replaces the account email with a non-deliverable address, so this duplicate account
            loses email sign-in and email delivery. It does not merge accounts, change billing or
            subscriptions, or revoke access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => releaseEmailAddress.mutate({ userId, expectedEmail: email })}
            disabled={isPending}
          >
            {isPending ? 'Releasing email address...' : 'Release email address'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
