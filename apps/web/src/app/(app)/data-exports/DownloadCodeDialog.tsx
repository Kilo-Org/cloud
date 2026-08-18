'use client';

import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/lib/trpc/utils';
import { DOWNLOAD_CODE_LENGTH, type DownloadCodeChallenge } from './data-export-contract';

const CODE_INPUT_ID = 'data-export-download-code';
const CODE_HINT_ID = 'data-export-download-code-hint';
const CODE_ERROR_ID = 'data-export-download-code-error';

type DownloadCodeDialogProps = {
  challenge: DownloadCodeChallenge | null;
  open: boolean;
  isResending: boolean;
  onResend: () => void;
  onClose: () => void;
  onVerified: (downloadUrl: string) => void;
};

function describeError(code: string | undefined, message: string): string {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'TOO_MANY_REQUESTS':
    case 'CONFLICT':
      // These carry actionable, user-safe copy from the server.
      return message;
    case 'PRECONDITION_FAILED':
      return 'Download signing is temporarily unavailable. Your code is still valid, so try again in a few minutes.';
    case 'NOT_FOUND':
      return 'This export is no longer available to download. Request a new export.';
    default:
      return 'The download could not be started. Try again.';
  }
}

export function DownloadCodeDialog({
  challenge,
  open,
  isResending,
  onResend,
  onClose,
  onVerified,
}: DownloadCodeDialogProps) {
  const trpc = useTRPC();
  const [code, setCode] = useState('');

  const createDownload = useMutation(
    trpc.userExports.createDownload.mutationOptions({
      onSuccess: result => {
        onVerified(result.downloadUrl);
        onClose();
      },
    })
  );

  // A newly issued challenge invalidates whatever was typed against the old one.
  useEffect(() => {
    setCode('');
    createDownload.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the challenge changes
  }, [challenge?.challengeId]);

  const errorMessage = createDownload.error
    ? describeError(createDownload.error.data?.code, createDownload.error.message)
    : null;
  const expiresInMinutes = challenge
    ? Math.max(1, Math.ceil((challenge.expiresAt - Date.now()) / 60_000))
    : 10;

  return (
    <Dialog
      open={open && challenge !== null}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Enter your download code</DialogTitle>
          <DialogDescription>
            We emailed a {DOWNLOAD_CODE_LENGTH}-digit code to your account address. It authorizes
            one download and expires in {expiresInMinutes} minutes.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault();
            if (!challenge || code.length !== DOWNLOAD_CODE_LENGTH) return;
            createDownload.mutate({
              exportId: challenge.exportId,
              challengeId: challenge.challengeId,
              code,
            });
          }}
        >
          <Label htmlFor={CODE_INPUT_ID}>Download code</Label>
          <Input
            id={CODE_INPUT_ID}
            value={code}
            onChange={event =>
              setCode(event.target.value.replace(/\D/g, '').slice(0, DOWNLOAD_CODE_LENGTH))
            }
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={DOWNLOAD_CODE_LENGTH}
            aria-describedby={errorMessage ? CODE_ERROR_ID : CODE_HINT_ID}
            aria-invalid={errorMessage !== null}
            className="font-mono tracking-[0.4em]"
          />
          {errorMessage ? (
            <p id={CODE_ERROR_ID} role="alert" className="text-destructive text-sm">
              {errorMessage}
            </p>
          ) : (
            <p id={CODE_HINT_ID} className="text-muted-foreground text-sm">
              Do not share this code. It unlocks a copy of your data export.
            </p>
          )}

          <DialogFooter className="mt-4 gap-2">
            <Button type="button" variant="outline" onClick={onResend} disabled={isResending}>
              {isResending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Sending code...
                </>
              ) : (
                'Send a new code'
              )}
            </Button>
            <Button
              type="submit"
              disabled={code.length !== DOWNLOAD_CODE_LENGTH || createDownload.isPending}
            >
              {createDownload.isPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Verifying code...
                </>
              ) : (
                'Download export'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
