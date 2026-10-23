import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import {
  manualReviewStartFailureKey,
  manualReviewStartFailureMessage,
} from './manual-review-start-error';

/** A tRPC client error as the mutation reports it: `data.code` plus a message. */
function trpcError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}

// The connected path's NOT_FOUND text: same code, a different sentence from
// the copy the screen renders, so the assertion proves code-based mapping.
const SERVER_NOT_FOUND = 'No connected GitHub installation can read this pull request.';

describe('manualReviewStartFailureKey', () => {
  it.each([
    ['NOT_FOUND', 'codeReviewer.manualReview.startNotFound'],
    ['TOO_MANY_REQUESTS', 'codeReviewer.manualReview.startRateLimited'],
    ['FORBIDDEN', 'codeReviewer.manualReview.startNotAllowed'],
    ['UNAUTHORIZED', 'codeReviewer.manualReview.startNotAllowed'],
    ['PRECONDITION_FAILED', 'codeReviewer.manualReview.startProviderNeedsAttention'],
    ['CONFLICT', 'codeReviewer.manualReview.startAlreadyRunning'],
    ['BAD_REQUEST', 'codeReviewer.manualReview.startRejected'],
    ['BAD_GATEWAY', 'codeReviewer.manualReview.startProviderUnavailable'],
  ])('maps %s to its own copy', (code, key) => {
    expect(manualReviewStartFailureKey(trpcError(code, 'server copy'))).toBe(key);
  });

  it('keeps the generic copy for a code it does not map', () => {
    expect(manualReviewStartFailureKey(trpcError('INTERNAL_SERVER_ERROR', 'boom'))).toBe(
      'codeReviewer.unknownError'
    );
  });

  it('uses the transport copy for an error that carries no code', () => {
    expect(manualReviewStartFailureKey(new Error('Network request failed'))).toBe(
      'codeReviewer.manualReview.startFailed'
    );
    expect(manualReviewStartFailureKey(undefined)).toBe('codeReviewer.manualReview.startFailed');
  });

  it('reads the code from every shape a tRPC error carries', () => {
    expect(manualReviewStartFailureKey({ data: { code: 'NOT_FOUND' } })).toBe(
      'codeReviewer.manualReview.startNotFound'
    );
    expect(manualReviewStartFailureKey({ shape: { data: { code: 'CONFLICT' } } })).toBe(
      'codeReviewer.manualReview.startAlreadyRunning'
    );
    expect(manualReviewStartFailureKey({ code: 'NOT_FOUND' })).toBe(
      'codeReviewer.manualReview.startNotFound'
    );
    // A non-string code is no code: the transport copy renders instead of a
    // malformed catalog key.
    expect(manualReviewStartFailureKey({ data: { code: 42 } })).toBe(
      'codeReviewer.manualReview.startFailed'
    );
  });
});

describe('manualReviewStartFailureMessage', () => {
  it('renders localized copy instead of the server message', () => {
    const message = manualReviewStartFailureMessage(
      trpcError('NOT_FOUND', SERVER_NOT_FOUND),
      'github'
    );
    expect(message).toBe(
      'Could not read that pull request from GitHub. Check the URL and that the repository is accessible.'
    );
    expect(message).not.toBe(SERVER_NOT_FOUND);
    expect(message).not.toContain('{{');
  });

  it('uses the merge-request noun for GitLab', () => {
    const message = manualReviewStartFailureMessage(
      trpcError(
        'CONFLICT',
        'A provider-publishing Code Reviewer job is already active for this change.'
      ),
      'gitlab'
    );
    expect(message).toBe('A review for that merge request is already running.');
  });

  it('follows the app language', async () => {
    await i18n.changeLanguage('hi');
    try {
      const message = manualReviewStartFailureMessage(
        trpcError('NOT_FOUND', SERVER_NOT_FOUND),
        'github'
      );
      expect(message).toContain('GitHub');
      expect(message).toContain(i18n.t('common.pullRequest'));
      expect(message).not.toContain('Could not read');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
