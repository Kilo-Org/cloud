/**
 * Reader-facing copy for a review that ended cancelled or interrupted.
 *
 * The cancellation writers store a short internal diagnostic in `error_message`
 * (see `apps/web/src/lib/code-reviews/db/code-reviews.ts`) and keep doing so:
 * the phrase is a diagnostic for us, it is not written for the customer, and it
 * is not translated. Every surface that shows a review maps it here instead.
 *
 * Causes the stored row can tell apart say what happened and what to do next.
 * Every other cancellation names the outcome rather than echoing the phrase,
 * because inventing a cause for a row we cannot attribute would be wrong.
 */

/** Label shown beside the message: the outcome, in the same voice as the status. */
export type CodeReviewCancellationCopy = {
  label: 'Cancelled' | 'Interrupted';
  message: string;
};

/** Written by `cancelActiveCodeReviewsForIntegration`, with reason
 *  `user_cancelled`, so the phrase is what separates it from a user cancel. */
const INTEGRATION_DISCONNECTED_MESSAGE = 'Platform integration disconnected';

/**
 * A Map rather than an object literal: the key is the raw `error_message`
 * column, so a value of `constructor` or `__proto__` would resolve an inherited
 * member on an object literal. terminal-reason-copy.ts uses the same shape for
 * the same reason.
 */
const CAUSE_BY_MESSAGE = new Map<string, string>([
  [
    'Bitbucket Code Reviewer disabled',
    'Code Reviewer was turned off for Bitbucket, so this review was cancelled. Enable it again, then re-run the review.',
  ],
  [
    'Bitbucket pull request state superseded this review',
    'The Bitbucket pull request changed, so this review was replaced.',
  ],
]);

function platformLabel(platform: string | null | undefined): string {
  if (platform === 'github') return 'GitHub';
  if (platform === 'gitlab') return 'GitLab';
  if (platform === 'bitbucket') return 'Bitbucket';
  return 'The integration';
}

export function getCodeReviewCancellationCopy(input: {
  status: string | null | undefined;
  terminalReason: string | null | undefined;
  errorMessage: string | null | undefined;
  platform: string | null | undefined;
}): CodeReviewCancellationCopy | null {
  if (input.status !== 'cancelled' && input.status !== 'interrupted') return null;
  const message = input.errorMessage;
  // Nothing stored means nothing was explained away, so there is no notice to
  // render: the status alone is the whole outcome.
  if (!message) return null;
  const label = input.status === 'cancelled' ? 'Cancelled' : 'Interrupted';

  if (message === INTEGRATION_DISCONNECTED_MESSAGE) {
    return {
      label,
      message: `${platformLabel(input.platform)} is disconnected, so this review was cancelled. Reconnect it, then re-run the review.`,
    };
  }

  const cause = CAUSE_BY_MESSAGE.get(message);
  if (cause) return { label, message: cause };

  if (input.terminalReason === 'superseded' || message.startsWith('Superseded by ')) {
    return { label, message: 'A newer commit was pushed, so this review was replaced.' };
  }

  return {
    label,
    message: label === 'Cancelled' ? 'This review was cancelled.' : 'This review was interrupted.',
  };
}
