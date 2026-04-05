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

export default function ResetAPIKeyButton({ userId }: { userId: string }) {
  const [isDialogOpen, setDialogOpen] = useState(false);
  const trpc = useTRPC();

  const resetAPIKeyMutation = useMutation(
    trpc.admin.users.resetAPIKey.mutationOptions({
      onSuccess: () => {
        toast.success('API Key was successfully reset!');
        setDialogOpen(false);
      },
    })
  );

  return (
    <Dialog open={isDialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Reset API keys
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset API keys</DialogTitle>
          <DialogDescription>
            Are you sure that you want to reset the API keys for this user? This action can not be
            undone!
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={resetAPIKeyMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => resetAPIKeyMutation.mutate({ userId })}
            disabled={resetAPIKeyMutation.isPending}
          >
            Reset API Keys
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
