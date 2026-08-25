'use client';

// Default `React` is required by Jest's SWC classic JSX transform; production
// uses the automatic JSX runtime from tsconfig.
import React, { useState, type FormEvent } from 'react';
import { signOut } from 'next-auth/react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type DialogStep = 'confirm' | 'code';

export function DeleteAccountDialog() {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<DialogStep>('confirm');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const challengeMutation = useMutation(
    trpc.user.requestAccountDeletionChallenge.mutationOptions({
      onSuccess: result => {
        setChallengeId(result.challengeId);
        setCode(process.env.NODE_ENV === 'development' ? (result.devCode ?? '') : '');
        setStep('code');
      },
      onError: error => toast.error(error.message),
    })
  );

  const deletionMutation = useMutation(
    trpc.user.requestAccountDeletion.mutationOptions({
      onSuccess: async () => {
        toast.success('Account deletion has started. Completion will be confirmed by email.');
        await signOut({ callbackUrl: '/users/sign_in' });
      },
      onError: error => toast.error(error.message),
    })
  );
  const isPending = challengeMutation.isPending || deletionMutation.isPending;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
  };

  const handleRequestCode = () => {
    challengeMutation.mutate();
  };

  const handleDeleteAccount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!challengeId) return;
    deletionMutation.mutate({ challengeId, code: code.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="min-h-control-touch self-start text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          Delete account
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!isPending}
        onEscapeKeyDown={event => {
          if (isPending) event.preventDefault();
        }}
        onPointerDownOutside={event => {
          if (isPending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete account</DialogTitle>
          <DialogDescription>
            This permanently deletes and anonymizes your Kilo account and signs you out. Cancel any
            active Kilo Pass or KiloClaw subscription before continuing.
          </DialogDescription>
        </DialogHeader>

        {step === 'confirm' ? (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-control-touch"
              onClick={() => handleOpenChange(false)}
              disabled={challengeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-control-touch"
              onClick={handleRequestCode}
              disabled={challengeMutation.isPending}
            >
              {challengeMutation.isPending
                ? 'Sending confirmation code...'
                : 'Send confirmation code'}
            </Button>
          </DialogFooter>
        ) : (
          <form onSubmit={handleDeleteAccount}>
            <div className="space-y-2 py-2">
              <Label htmlFor="account-deletion-code">Confirmation code</Label>
              <Input
                id="account-deletion-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={event => setCode(event.target.value)}
                disabled={deletionMutation.isPending}
                aria-describedby="account-deletion-code-help"
              />
              <p id="account-deletion-code-help" className="text-muted-foreground text-sm">
                Enter the code sent to your account email to confirm deletion.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-control-touch"
                onClick={() => handleOpenChange(false)}
                disabled={deletionMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                className="min-h-control-touch"
                disabled={deletionMutation.isPending}
              >
                {deletionMutation.isPending ? 'Starting deletion...' : 'Delete account'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
