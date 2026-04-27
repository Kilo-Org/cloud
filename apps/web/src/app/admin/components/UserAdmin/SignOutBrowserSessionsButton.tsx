'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';

export default function SignOutBrowserSessionsButton({ userId }: { userId: string }) {
  const [isDialogOpen, setDialogOpen] = useState(false);
  const trpc = useTRPC();

  const signOutBrowserSessionsMutation = useMutation(
    trpc.admin.users.signOutBrowserSessions.mutationOptions({
      onSuccess: () => {
        toast.success('Browser sessions were successfully signed out!');
        setDialogOpen(false);
      },
    })
  );

  return (
    <Dialog open={isDialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Sign out browser sessions
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign out browser sessions</DialogTitle>
          <DialogDescription>
            Are you sure that you want to sign out all browser sessions for this user? CLI, VS Code,
            JetBrains, and other API tokens will continue to work.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={signOutBrowserSessionsMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => signOutBrowserSessionsMutation.mutate({ userId })}
            disabled={signOutBrowserSessionsMutation.isPending}
          >
            {signOutBrowserSessionsMutation.isPending
              ? 'Signing out...'
              : 'Sign Out Browser Sessions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
