import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

import { manualReviewStartFailure } from './manual-review-start-error';

/** A tRPC client error as the mutation reports it: `data.code` plus a message. */
function trpcError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}

// The connected path's NOT_FOUND text: same code, a different sentence from
// the copy the screen renders, so the assertion proves code-based mapping.
const SERVER_NOT_FOUND = 'No connected GitHub installation can read this pull request.';
// The refusal `ensureOrganizationAccess` throws for a narrower role.
const SERVER_MEMBER_ROLE = 'You do not have the required organizational role to access this feature';

describe('manualReviewStartFailure copy', () => {
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
    expect(manualReviewStartFailure(trpcError(code, 'server copy'), 'github').message).toBe(
      i18n.t(key, { provider: 'GitHub', requestNoun: i18n.t('common.pullRequest') })
    );
  });

  it('keeps the generic copy for a code it does not map', () => {
    expect(manualReviewStartFailure(trpcError('INTERNAL_SERVER_ERROR', 'boom'), 'github').message).toBe(
      i18n.t('codeReviewer.unknownError')
    );
  });

  it('uses the transport copy for an error that carries no code', () => {
    expect(manualReviewStartFailure(new Error('Network request failed'), 'github').message).toBe(
      i18n.t('codeReviewer.manualReview.startFailed')
    );
    expect(manualReviewStartFailure(undefined, 'github').message).toBe(
      i18n.t('codeReviewer.manualReview.startFailed')
    );
  });

  it('reads the code from every shape a tRPC error carries', () => {
    expect(manualReviewStartFailure({ data: { code: 'NOT_FOUND' } }, 'github').message).toBe(
      i18n.t('codeReviewer.manualReview.startNotFound', {
        provider: 'GitHub',
        requestNoun: i18n.t('common.pullRequest'),
      })
    );
    expect(manualReviewStartFailure({ shape: { data: { code: 'CONFLICT' } } }, 'github').message).toBe(
      i18n.t('codeReviewer.manualReview.startAlreadyRunning', {
        provider: 'GitHub',
        requestNoun: i18n.t('common.pullRequest'),
      })
    );
    // A non-string code is no code: the transport copy renders instead of a
    // malformed catalog key.
    expect(manualReviewStartFailure({ data: { code: 42 } }, 'github').message).toBe(
      i18n.t('codeReviewer.manualReview.startFailed')
    );
  });
});

describe('manualReviewStartFailure recognized server sentences', () => {
  it('explains an expired organization trial instead of the generic denial', () => {
    const failure = manualReviewStartFailure(
      trpcError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE),
      'github'
    );

    expect(failure.message).toBe(i18n.t('common.organizationTrialEnded'));
    expect(failure.message).not.toBe(
      i18n.t('codeReviewer.manualReview.startNotAllowed', {
        provider: 'GitHub',
        requestNoun: i18n.t('common.pullRequest'),
      })
    );
    expect(failure.retryable).toBe(false);
  });

  it('keeps the generic denial for a role the server does not explain', () => {
    const failure = manualReviewStartFailure(trpcError('FORBIDDEN', SERVER_MEMBER_ROLE), 'github');

    expect(failure.message).toBe(
      i18n.t('codeReviewer.manualReview.startNotAllowed', {
        provider: 'GitHub',
        requestNoun: i18n.t('common.pullRequest'),
      })
    );
    expect(failure.retryable).toBe(false);
  });
});

describe('manualReviewStartFailure retryability', () => {
  it.each(['BAD_GATEWAY', 'TOO_MANY_REQUESTS', 'PRECONDITION_FAILED', 'CONFLICT'])(
    'offers the retry for %s',
    code => {
      expect(manualReviewStartFailure(trpcError(code, 'server copy'), 'github').retryable).toBe(
        true
      );
    }
  );

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'BAD_REQUEST', 'UNPROCESSABLE_CONTENT'])(
    'drops the retry for the terminal code %s',
    code => {
      expect(manualReviewStartFailure(trpcError(code, 'server copy'), 'github').retryable).toBe(
        false
      );
    }
  );

  it('offers the retry for a transport failure with no code', () => {
    expect(manualReviewStartFailure(new Error('Network request failed'), 'github').retryable).toBe(
      true
    );
  });
});

describe('manualReviewStartFailure localization', () => {
  it('renders localized copy instead of the server message', () => {
    const { message } = manualReviewStartFailure(trpcError('NOT_FOUND', SERVER_NOT_FOUND), 'github');
    expect(message).toBe(
      'Could not read that pull request from GitHub. Check the URL and that the repository is accessible.'
    );
    expect(message).not.toBe(SERVER_NOT_FOUND);
    expect(message).not.toContain('{{');
  });

  it('uses the merge-request noun for GitLab', () => {
    const { message } = manualReviewStartFailure(
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
      const { message } = manualReviewStartFailure(
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
