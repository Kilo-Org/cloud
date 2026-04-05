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

export default function ResetToMagicLinkLoginButton({ userId }: { userId: string }) {
  const [isDialogOpen, setDialogOpen] = useState(false);
  const trpc = useTRPC();

  const resetToMagicLinkMutation = useMutation(
    trpc.admin.users.resetToMagicLinkLogin.mutationOptions({
      onSuccess: () => {
        toast.success('Account reset to magic link login!');
        setDialogOpen(false);
      },
    })
  );

  return (
    <Dialog open={isDialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Reset to magic link login
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset to magic link login</DialogTitle>
          <DialogDescription>
            Are you sure you want to reset this account to magic link login? This will remove all
            connected authentication providers (Google, GitHub, etc.) and the user will only be able
            to log in via magic link email.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={resetToMagicLinkMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => resetToMagicLinkMutation.mutate({ userId })}
            disabled={resetToMagicLinkMutation.isPending}
          >
            Reset to magic link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
