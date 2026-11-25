'use client';

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
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { signOut } from 'next-auth/react';

export function ResetAPITokenDialog() {
  const trpc = useTRPC();

  const resetAPIKeyMutation = useMutation(
    trpc.user.resetAPIKey.mutationOptions({
      onSuccess: async () => {
        toast.success(
          'API token reset and all sessions signed out. Redirecting to sign-in page...'
        );
        await signOut({ callbackUrl: '/users/sign_in' });
      },
    })
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive">
          <RotateCcw className="mr-2 h-4 w-4" />
          Reset API Token
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-orange-600">
            <AlertTriangle className="h-5 w-5" />
            Reset all API tokens?
          </DialogTitle>
          <DialogDescription className="text-muted-foreground pt-3">
            <strong className="text-foreground">This action cannot be undone.</strong>
            <br />
            <br />
            Resetting your API token will invalidate all existing CLI, VS Code, JetBrains, and other
            API tokens. It also signs you out of every browser and the mobile app, including this
            one, so you will need to sign in again.
          </DialogDescription>
          {resetAPIKeyMutation.isError && (
            <p className="text-destructive text-sm">
              The reset did not complete. Nothing was changed; try again.
            </p>
          )}
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild>
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={resetAPIKeyMutation.isPending}
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            onClick={() => resetAPIKeyMutation.mutate()}
            disabled={resetAPIKeyMutation.isPending}
          >
            {resetAPIKeyMutation.isPending ? 'Resetting...' : 'Reset API Token'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
