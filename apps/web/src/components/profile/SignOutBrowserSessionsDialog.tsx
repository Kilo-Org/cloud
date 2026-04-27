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
import { AlertTriangle, LogOut } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { signOut } from 'next-auth/react';

export function SignOutBrowserSessionsDialog() {
  const trpc = useTRPC();

  const signOutBrowserSessionsMutation = useMutation(
    trpc.user.signOutBrowserSessions.mutationOptions({
      onSuccess: async () => {
        toast.success('Browser sessions signed out. Redirecting to sign-in page...');
        await signOut({ callbackUrl: '/users/sign_in' });
      },
    })
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <LogOut className="mr-2 h-4 w-4" />
          Sign Out Browser Sessions
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-orange-600">
            <AlertTriangle className="h-5 w-5" />
            Sign out all browser sessions?
          </DialogTitle>
          <DialogDescription className="text-muted-foreground pt-3">
            This will sign you out of Kilo Code in every browser, including this one. CLI, VS Code,
            JetBrains, and other API tokens will continue to work.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild>
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={signOutBrowserSessionsMutation.isPending}
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            onClick={() => signOutBrowserSessionsMutation.mutate()}
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
