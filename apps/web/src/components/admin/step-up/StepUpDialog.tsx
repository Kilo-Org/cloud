'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { PasskeyRegistrationError, registerNewPasskey } from '@/components/profile/PasskeysCard';
import { useTRPC } from '@/lib/trpc/utils';
import {
  stepUpDialogDescription,
  stepUpDialogTitle,
  type StepUpRequirement,
} from './step-up-error';
import { runStepUpCeremony, type StepUpOptions } from './step-up-ceremony';
import { StepUpSignInAgainButton } from './StepUpSignInAgainButton';

async function requestOptions(): Promise<StepUpOptions> {
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
    case 'STEP_UP_UNAVAILABLE':
      return 'Verification is temporarily unavailable. Try again shortly.';
    default:
      return 'Could not verify with a passkey. Try again.';
  }
}

/**
 * The verification UI itself. Rendered inside the global Dialog on admin
 * pages and inline in the full-page interstitial.
 */
export function StepUpCeremonyContent({
  requirement,
  onVerified,
  onCancel,
  dismissible = true,
  headings = 'dialog',
  headingLevel = 'h2',
  onRunningChange,
}: {
  requirement: StepUpRequirement | null;
  onVerified: () => void;
  onCancel: () => void;
  dismissible?: boolean;
  headings?: 'dialog' | 'plain';
  headingLevel?: 'h1' | 'h2';
  onRunningChange?: (running: boolean) => void;
}) {
  const trpc = useTRPC();
  const [isRunning, setIsRunning] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const statusQuery = useQuery({
    ...trpc.stepUp.getStatus.queryOptions(),
    staleTime: 0,
  });
  const current = requirement ?? { code: 'MFA_REQUIRED' as const };
  const statusKnown = statusQuery.isSuccess;
  const statusFailed = statusQuery.isError;
  const unavailable = statusQuery.data?.unavailable === true;
  const needsSignIn =
    current.code === 'SESSION_UNBOUND' ||
    current.code === 'BEARER_NOT_ALLOWED' ||
    current.code === 'REAUTH_REQUIRED' ||
    (statusKnown && statusQuery.data?.sessionBound === false);

  async function runCeremony() {
    if (isRunning) return;
    setIsRunning(true);
    setError(null);
    setReauthRequired(false);

    try {
      const result = await runStepUpCeremony({
        requestOptions,
        startAuthentication: options => startAuthentication({ optionsJSON: options }),
        submitAssertion,
        enroll: registerNewPasskey,
      });
      if (result.ok) {
        onVerified();
        return;
      }
      if (result.code === 'CANCELLED') {
        setError('Passkey verification was cancelled. No verification was recorded.');
      } else {
        setError(errorMessage(result.code));
      }
    } catch (caught) {
      if (caught instanceof PasskeyRegistrationError && caught.failure === 'cancelled') {
        setError('Passkey creation was cancelled. No passkey was added.');
      } else if (
        caught instanceof PasskeyRegistrationError &&
        caught.failure === 'reauth_required'
      ) {
        setReauthRequired(true);
        setError(
          'Sign in again before adding a passkey to an admin account. Signing out signs you out of every browser.'
        );
      } else {
        setError('Passkey verification did not complete. Try again.');
      }
    } finally {
      setIsRunning(false);
    }
  }

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  async function retryStatus() {
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      await statusQuery.refetch();
    } finally {
      setIsRetrying(false);
    }
  }

  const enrolled = statusQuery.data?.enrolled ?? false;
  const retrying = isRetrying;
  const actionLabel = !statusKnown
    ? statusFailed
      ? retrying
        ? 'Checking...'
        : 'Retry status check'
      : 'Checking your passkeys...'
    : unavailable
      ? retrying
        ? 'Checking...'
        : 'Retry status check'
      : enrolled
        ? 'Verify with passkey'
        : 'Add a passkey';
  const actionDisabled = isRunning || (!statusKnown && !statusFailed) || retrying;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-muted">
          {needsSignIn ? (
            <KeyRound className="size-4" aria-hidden="true" />
          ) : (
            <ShieldCheck className="size-4" aria-hidden="true" />
          )}
        </span>
        {headings === 'dialog' ? (
          <DialogTitle>{stepUpDialogTitle(current)}</DialogTitle>
        ) : headingLevel === 'h1' ? (
          <h1 className="text-lg font-semibold">{stepUpDialogTitle(current)}</h1>
        ) : (
          <h2 className="text-lg font-semibold">{stepUpDialogTitle(current)}</h2>
        )}
      </div>
      {headings === 'dialog' ? (
        <DialogDescription>{stepUpDialogDescription(current)}</DialogDescription>
      ) : (
        <p className="text-sm text-muted-foreground">{stepUpDialogDescription(current)}</p>
      )}

      {!statusKnown && !statusFailed ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Checking your passkeys...
        </p>
      ) : statusFailed || unavailable ? (
        <p className="mt-4 text-sm text-muted-foreground" role="alert">
          Could not check verification status. Try again.
        </p>
      ) : null}

      {error ? (
        <p ref={errorRef} tabIndex={-1} className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {needsSignIn || reauthRequired ? (
          <StepUpSignInAgainButton size="default" />
        ) : (
          <Button
            onClick={() => (statusFailed || unavailable ? void retryStatus() : void runCeremony())}
            disabled={actionDisabled}
          >
            {isRunning || retrying ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                {retrying ? 'Checking...' : 'Waiting for your passkey...'}
              </>
            ) : (
              actionLabel
            )}
          </Button>
        )}
        {dismissible ? (
          <Button variant="outline" onClick={onCancel} disabled={isRunning}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function StepUpDialog({
  open,
  requirement,
  onVerified,
  onCancel,
  dismissible = true,
}: {
  open: boolean;
  requirement: StepUpRequirement | null;
  onVerified: () => void;
  onCancel: () => void;
  dismissible?: boolean;
}) {
  const [running, setRunning] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && dismissible && !running) onCancel();
      }}
    >
      <DialogContent>
        <StepUpCeremonyContent
          requirement={requirement}
          onVerified={onVerified}
          onCancel={onCancel}
          dismissible={dismissible}
          headings="dialog"
          onRunningChange={setRunning}
        />
      </DialogContent>
    </Dialog>
  );
}
