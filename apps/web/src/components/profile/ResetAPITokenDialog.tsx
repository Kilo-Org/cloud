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
import { useRouter } from 'next/navigation';

export function ResetAPITokenDialog() {
  const trpc = useTRPC();
  const router = useRouter();

  const resetAPIKeyMutation = useMutation(
    trpc.user.resetAPIKey.mutationOptions({
      onSuccess: () => {
        toast.success('API token reset successfully. Redirecting to sign-in page...');
        router.push('/users/sign_in');
      },
    })
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive">
          <RotateCcw className="mr-2 h-4 w-4" />
          Reset Token and Sign Out
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-orange-600">
            <AlertTriangle className="h-5 w-5" />
            Reset all API tokens and sign out everywhere.
          </DialogTitle>
          <DialogDescription className="text-muted-foreground pt-3">
            <strong className="text-foreground">This action cannot be undone.</strong>
            <br />
            <br />
            Resetting your API token will invalidate all existing tokens. You will also be signed
            out of all sessions. If you procees, you will need to sign in again and then re-open in
            VS Code and/or other Kilo Code extensions.
          </DialogDescription>
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
            {resetAPIKeyMutation.isPending ? 'Resetting...' : 'Reset API Token and Sign Out'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
