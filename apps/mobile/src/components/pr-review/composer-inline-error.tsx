// Inline error area for the comment composer. Local empty-body validation has
// no toast owner, so AccessibleStatus announces it on both platforms;
// mutation-classified errors are toast-owned (announcingToast) and stay
// visual-only so they never double-announce.

import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { ensureTermsAccepted } from '@/components/pr-review/discussion/reply-input';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { mutationErrorDisplay } from '@/lib/pr-review/mutation-error-display';

export type ComposerInlineErrorKind =
  | 'retryable'
  | 'bad-request'
  | 'forbidden'
  | 'reconnect'
  | null;

type ComposerInlineErrorProps = {
  readonly inlineError: string | null;
  readonly inlineErrorKind: ComposerInlineErrorKind;
  readonly inlineErrorIsLocal: boolean;
};

export function ComposerInlineError({
  inlineError,
  inlineErrorKind,
  inlineErrorIsLocal,
}: Readonly<ComposerInlineErrorProps>) {
  return (
    <>
      {inlineError && inlineErrorKind !== 'reconnect' ? (
        <View className="rounded-md border border-destructive bg-red-50 dark:bg-red-950 px-2.5 py-1.5">
          {inlineErrorIsLocal ? (
            <AccessibleStatus message={inlineError} tone="error" className="text-xs" />
          ) : (
            <Text className="text-xs text-destructive">{inlineError}</Text>
          )}
        </View>
      ) : null}
      {inlineErrorKind === 'reconnect' ? <PrReviewReconnectNotice /> : null}
    </>
  );
}

/**
 * Inline-error state for the composer. Mirrors the create-comment mutation
 * error into the inline box, and clears the recoverable bad-request state
 * when the body changes. The Terms gate is prompted here on a terms-required
 * classification.
 */
export function useComposerInlineError(error: unknown, isEdit: boolean) {
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<ComposerInlineErrorKind>(null);
  // True when `inlineError` is a local empty-body validation error (no
  // mutation toast owns it), so it must announce through AccessibleStatus;
  // mutation-classified errors are toast-owned and stay visual-only.
  const [inlineErrorIsLocal, setInlineErrorIsLocal] = useState(false);

  useEffect(() => {
    if (isEdit || !error) {
      return;
    }
    const classification = classifyPrReviewMutationError(error);
    if (classification.kind === 'terms-required') {
      void (async () => {
        const accepted = await ensureTermsAccepted();
        if (accepted) {
          setInlineError(null);
          setInlineErrorKind(null);
          setInlineErrorIsLocal(false);
        } else {
          setInlineError('You must accept the Terms of Service to post.');
          setInlineErrorKind(null);
          setInlineErrorIsLocal(true);
        }
      })();
      return;
    }
    const display = mutationErrorDisplay('composer', classification, error);
    setInlineError(display.message);
    setInlineErrorKind(display.kind);
    setInlineErrorIsLocal(false);
  }, [error, isEdit]);

  function clearBadRequestOnBodyEdit() {
    // bad-request clears on body change; forbidden stays for the session.
    if (inlineErrorKind === 'bad-request') {
      setInlineError(null);
      setInlineErrorKind(null);
      setInlineErrorIsLocal(false);
    }
  }

  return {
    inlineError,
    inlineErrorKind,
    inlineErrorIsLocal,
    setInlineError,
    setInlineErrorKind,
    setInlineErrorIsLocal,
    clearBadRequestOnBodyEdit,
  };
}
