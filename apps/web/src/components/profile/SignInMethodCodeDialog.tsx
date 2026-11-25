'use client';

import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuthProviderId } from '@kilocode/db/schema-types';
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
import { getProviderById } from '@/lib/auth/provider-metadata';
import {
  SIGN_IN_METHOD_CHANGE_CODE_LENGTH,
  SIGN_IN_METHOD_CHANGE_ERROR_MESSAGES,
  SIGN_IN_METHOD_CODE_COOLDOWN_ERROR,
  SIGN_IN_METHOD_CODE_INVALID_ERROR,
  SIGN_IN_METHOD_CODE_LOCKED_ERROR,
  SIGN_IN_METHOD_CODE_SEND_FAILED_ERROR,
  signInMethodChangeError,
} from '@/lib/auth/sign-in-method-change-codes';
import { useTRPC } from '@/lib/trpc/utils';

const CODE_INPUT_ID = 'sign-in-method-change-code';
const CODE_HINT_ID = 'sign-in-method-change-code-hint';
const CODE_ERROR_ID = 'sign-in-method-change-code-error';

/** The page error code shown when the change fails for a reason this dialog does not explain. */
const FALLBACK_PAGE_ERROR = 'LINKING-FAILED';

type CodeStepErrorKind = 'invalid' | 'locked' | 'cooldown' | 'send_failed';

type CodeStepError = {
  kind: CodeStepErrorKind;
  message: string;
};

/**
 * The in-dialog error for a refusal that belongs to the code step, or null for
 * a refusal the page explains instead.
 */
function codeStepError(errorCode: string | null): CodeStepError | null {
  switch (errorCode) {
    case SIGN_IN_METHOD_CODE_INVALID_ERROR:
      return { kind: 'invalid', message: SIGN_IN_METHOD_CHANGE_ERROR_MESSAGES[errorCode] };
    case SIGN_IN_METHOD_CODE_LOCKED_ERROR:
      return { kind: 'locked', message: SIGN_IN_METHOD_CHANGE_ERROR_MESSAGES[errorCode] };
    case SIGN_IN_METHOD_CODE_COOLDOWN_ERROR:
      return { kind: 'cooldown', message: SIGN_IN_METHOD_CHANGE_ERROR_MESSAGES[errorCode] };
    case SIGN_IN_METHOD_CODE_SEND_FAILED_ERROR:
      return { kind: 'send_failed', message: SIGN_IN_METHOD_CHANGE_ERROR_MESSAGES[errorCode] };
    default:
      return null;
  }
}

/**
 * The last code the page requested. The server keeps one live code per
 * account, and a new code ends the previous one, so the page holds one
 * challenge for every card that asks for a code. It keeps it while the dialog
 * is closed, so reopening the dialog before the code expires lets the person
 * enter the code that is already in their mailbox. A dialog for another change
 * or provider does not use it and sends a new code instead.
 */
export type SignInMethodChallenge = {
  change: 'link' | 'unlink';
  provider: AuthProviderId;
  challengeId: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
};

export type SignInMethodCodeDialogProps = {
  open: boolean;
  change: 'link' | 'unlink';
  provider: AuthProviderId;
  /** The page's last requested code, or null. */
  challenge: SignInMethodChallenge | null;
  onChallengeChange: (challenge: SignInMethodChallenge | null) => void;
  onOpenChange: (open: boolean) => void;
  /**
   * Reports a page error code for a failure this dialog does not show itself,
   * such as a change that needs a browser session or a single sign-on policy
   * refusal. The dialog closes before it is called.
   */
  onError: (error: string) => void;
  /**
   * Confirms the code with the change. Reject with the mutation error to keep
   * the person in the dialog: a code refusal shows there and can be retried.
   */
  onVerified: (code: string, challengeId: string) => Promise<void> | void;
};

/**
 * The one-time code step for a sign-in method change. The code is emailed to the
 * account's primary address when the dialog opens, unless the page still holds
 * an unexpired code for the same change and provider. The change itself is confirmed by
 * `onVerified`, so a wrong code keeps the person in the dialog.
 */
export function SignInMethodCodeDialog({
  open,
  change,
  provider,
  challenge,
  onChallengeChange,
  onOpenChange,
  onError,
  onVerified,
}: SignInMethodCodeDialogProps) {
  const trpc = useTRPC();
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<CodeStepError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const requestedKey = useRef<string | null>(null);

  const challengeId =
    challenge?.change === change && challenge.provider === provider ? challenge.challengeId : null;

  const requestCode = useMutation(
    trpc.user.requestSignInMethodChangeCode.mutationOptions({
      onSuccess: (data, variables) => {
        onChallengeChange({
          change: variables.change,
          provider: variables.provider,
          challengeId: data.challengeId,
          expiresAt: Date.now() + data.expiresInMinutes * 60_000,
        });
        setExpiresInMinutes(data.expiresInMinutes);
        setCode('');
        setCodeError(null);
      },
      onError: error => {
        const pageError = signInMethodChangeError(error);
        if (codeStepError(pageError)) return;
        onOpenChange(false);
        onError(pageError ?? FALLBACK_PAGE_ERROR);
      },
    })
  );

  // One code per open: a new provider, change or open sends at most one email,
  // and none while the page holds an unexpired code for this change. The ref
  // keeps a repeated effect run (a strict-mode double mount) from sending a
  // second code, which the server would refuse as a cooldown.
  useEffect(() => {
    if (!open) {
      requestedKey.current = null;
      setCode('');
      setCodeError(null);
      setIsSubmitting(false);
      requestCode.reset();
      return;
    }
    const key = `${change}:${provider}`;
    if (requestedKey.current === key) return;
    requestedKey.current = key;
    setCode('');
    setCodeError(null);
    const remainingMs =
      challenge?.change === change && challenge.provider === provider
        ? challenge.expiresAt - Date.now()
        : 0;
    if (remainingMs > 0) {
      setExpiresInMinutes(Math.ceil(remainingMs / 60_000));
      return;
    }
    onChallengeChange(null);
    setExpiresInMinutes(null);
    requestCode.mutate({ change, provider });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send one code per open
  }, [open, change, provider]);

  const requestError = requestCode.error
    ? codeStepError(signInMethodChangeError(requestCode.error))
    : null;
  const activeError = codeError ?? requestError;
  const isLocked = activeError?.kind === 'locked';
  const isRequesting = requestCode.isPending;
  const providerName = getProviderById(provider).name;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!challengeId || isSubmitting || isLocked) return;
    if (code.length !== SIGN_IN_METHOD_CHANGE_CODE_LENGTH) return;
    setIsSubmitting(true);
    setCodeError(null);
    try {
      await onVerified(code, challengeId);
      // The code works once.
      onChallengeChange(null);
      onOpenChange(false);
    } catch (error) {
      const pageError = signInMethodChangeError(error);
      const stepError = codeStepError(pageError);
      if (stepError) {
        setCodeError(stepError);
      } else {
        onOpenChange(false);
        onError(pageError ?? FALLBACK_PAGE_ERROR);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = () => {
    setCodeError(null);
    requestCode.mutate({ change, provider });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {change === 'link' ? `Link ${providerName}` : `Unlink ${providerName}`}
          </DialogTitle>
          <DialogDescription>
            {challengeId && expiresInMinutes !== null
              ? `We sent a ${SIGN_IN_METHOD_CHANGE_CODE_LENGTH}-digit code to your email. It expires in ${expiresInMinutes} minutes.`
              : isRequesting
                ? 'We are sending a code to your email.'
                : 'Enter the code we sent to your email.'}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
          <Label htmlFor={CODE_INPUT_ID}>Code</Label>
          <Input
            id={CODE_INPUT_ID}
            value={code}
            onChange={event =>
              setCode(
                event.target.value.replace(/\D/g, '').slice(0, SIGN_IN_METHOD_CHANGE_CODE_LENGTH)
              )
            }
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={SIGN_IN_METHOD_CHANGE_CODE_LENGTH}
            disabled={!challengeId || isLocked}
            aria-describedby={activeError ? CODE_ERROR_ID : CODE_HINT_ID}
            aria-invalid={activeError !== null}
            className="font-mono tracking-[0.4em]"
          />
          {activeError ? (
            <p id={CODE_ERROR_ID} role="alert" className="text-destructive text-sm">
              {activeError.message}
            </p>
          ) : (
            <p id={CODE_HINT_ID} className="text-muted-foreground text-sm">
              Enter the code to confirm this change. It works once.
            </p>
          )}

          <DialogFooter className="mt-4 gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleResend}
              disabled={isRequesting || isSubmitting || isLocked}
            >
              {isRequesting ? (
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
              variant={change === 'unlink' ? 'destructive' : 'default'}
              disabled={
                !challengeId ||
                code.length !== SIGN_IN_METHOD_CHANGE_CODE_LENGTH ||
                isSubmitting ||
                isLocked
              }
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="animate-spin" />
                  Checking code...
                </>
              ) : (
                'Confirm'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
