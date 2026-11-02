'use client';

import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PasskeyRegistrationError, registerNewPasskey } from '@/components/profile/PasskeysCard';
import { useTRPC } from '@/lib/trpc/utils';
import {
  stepUpDialogDescription,
  stepUpDialogTitle,
  type StepUpRequirement,
} from './step-up-error';

type OptionsResponse =
  | { ok: true; challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }
  | { ok: false; code?: string };

async function requestOptions(): Promise<OptionsResponse> {
  const response = await fetch('/api/auth/step-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'options' }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return { ok: false, code: typeof body.error === 'string' ? body.error : undefined };
  }
  if (typeof body.challengeId !== 'string' || typeof body.options !== 'object') {
    return { ok: false };
  }
  return {
    ok: true,
    challengeId: body.challengeId,
    options: body.options as PublicKeyCredentialRequestOptionsJSON,
  };
}

async function submitAssertion(challengeId: string, response: unknown): Promise<boolean> {
  const verify = await fetch('/api/auth/step-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'verify', challengeId, response }),
  });
  return verify.ok;
}

function errorMessage(code?: string): string {
  switch (code) {
    case 'NOT_ENROLLED':
      return 'No passkey is enrolled for this account.';
    case 'SESSION_UNBOUND':
      return 'This session can no longer be verified. Sign in again.';
    case 'REAUTH_REQUIRED':
      return 'Sign in again before verifying.';
    case 'CHALLENGE_ALREADY_USED':
    case 'CHALLENGE_EXPIRED':
      return 'That verification expired. Try again.';
    default:
      return 'Could not verify with a passkey. Try again.';
  }
}

/**
 * Session-bound step-up dialog. The only interaction is the browser's own
 * passkey sheet; the challenge, session binding, and proof stay server-side.
 */
export function StepUpDialog({
  open,
  requirement,
  onVerified,
  onCancel,
}: {
  open: boolean;
  requirement: StepUpRequirement | null;
  onVerified: () => void;
  onCancel: () => void;
}) {
  const trpc = useTRPC();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusQuery = useQuery({
    ...trpc.stepUp.getStatus.queryOptions(),
    enabled: open,
    staleTime: 0,
  });
  const current = requirement ?? { code: 'MFA_REQUIRED' as const };
  const needsSignIn =
    current.code === 'SESSION_UNBOUND' ||
    current.code === 'BEARER_NOT_ALLOWED' ||
    current.code === 'REAUTH_REQUIRED' ||
    statusQuery.data?.sessionBound === false;

  async function runCeremony() {
    if (isRunning) return;
    setIsRunning(true);
    setError(null);

    try {
      let options = await requestOptions();
      if (!options.ok && options.code === 'NOT_ENROLLED') {
        await registerNewPasskey();
        options = await requestOptions();
      }
      if (!options.ok) {
        setError(errorMessage(options.code));
        return;
      }

      const assertion = await startAuthentication({ optionsJSON: options.options });
      if (!(await submitAssertion(options.challengeId, assertion))) {
        setError(errorMessage());
        return;
      }

      onVerified();
    } catch (caught) {
      if (caught instanceof PasskeyRegistrationError && caught.failure === 'cancelled') {
        setError('Passkey creation was cancelled. No passkey was added.');
      } else {
        setError('Passkey verification did not complete. Try again.');
      }
    } finally {
      setIsRunning(false);
    }
  }

  const enrolled = statusQuery.data?.enrolled ?? false;
  const actionLabel =
    current.code === 'NOT_ENROLLED' || !enrolled ? 'Add a passkey' : 'Verify with passkey';

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && !isRunning) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <div className="mb-2 flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-muted">
              {needsSignIn ? (
                <KeyRound className="size-4" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-4" aria-hidden="true" />
              )}
            </span>
            <DialogTitle>{stepUpDialogTitle(current)}</DialogTitle>
          </div>
          <DialogDescription>{stepUpDialogDescription(current)}</DialogDescription>
        </DialogHeader>

        {statusQuery.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Checking your passkeys...
          </p>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {needsSignIn ? (
            <Button asChild>
              <Link href="/users/sign_in">Sign in again</Link>
            </Button>
          ) : (
            <Button onClick={() => void runCeremony()} disabled={isRunning}>
              {isRunning ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Waiting for your passkey...
                </>
              ) : (
                actionLabel
              )}
            </Button>
          )}
          <Button variant="outline" onClick={onCancel} disabled={isRunning}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
