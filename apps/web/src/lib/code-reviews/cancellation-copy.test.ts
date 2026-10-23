import { getCodeReviewCancellationCopy } from './cancellation-copy';

describe('getCodeReviewCancellationCopy', () => {
  it('returns null for reviews that did not end cancelled or interrupted', () => {
    expect(
      getCodeReviewCancellationCopy({
        status: 'completed',
        terminalReason: null,
        errorMessage: 'Superseded by new push',
        platform: 'github',
      })
    ).toBeNull();
  });

  it('returns null when the row stores no message to explain', () => {
    expect(
      getCodeReviewCancellationCopy({
        status: 'cancelled',
        terminalReason: 'user_cancelled',
        errorMessage: null,
        platform: 'github',
      })
    ).toBeNull();
  });

  it('explains a review replaced by a newer commit', () => {
    const expected = {
      label: 'Cancelled',
      message: 'A newer commit was pushed, so this review was replaced.',
    };
    expect(
      getCodeReviewCancellationCopy({
        status: 'cancelled',
        terminalReason: 'superseded',
        errorMessage: 'Superseded by new push',
        platform: 'github',
      })
    ).toEqual(expected);
    expect(
      getCodeReviewCancellationCopy({
        status: 'cancelled',
        terminalReason: null,
        errorMessage: 'Superseded by duplicate merge-commit continuation',
        platform: 'gitlab',
      })
    ).toEqual(expected);
  });

  it('names the disconnected platform in the recovery step', () => {
    expect(
      getCodeReviewCancellationCopy({
        status: 'cancelled',
        terminalReason: 'user_cancelled',
        errorMessage: 'Platform integration disconnected',
        platform: 'gitlab',
      })
    ).toEqual({
      label: 'Cancelled',
      message:
        'GitLab is disconnected, so this review was cancelled. Reconnect it, then re-run the review.',
    });
  });

  it('explains both Bitbucket cancellation causes', () => {
    expect(
      getCodeReviewCancellationCopy({
        status: 'cancelled',
        terminalReason: 'user_cancelled',
        errorMessage: 'Bitbucket Code Reviewer disabled',
        platform: 'bitbucket',
      })?.message
    ).toContain('turned off for Bitbucket');
    expect(
      getCodeReviewCancellationCopy({
        status: 'cancelled',
        terminalReason: 'user_cancelled',
        errorMessage: 'Bitbucket pull request state superseded this review',
        platform: 'bitbucket',
      })?.message
    ).toBe('The Bitbucket pull request changed, so this review was replaced.');
  });

  it('falls back to the outcome for a cause the row cannot tell apart', () => {
    expect(
      getCodeReviewCancellationCopy({
        status: 'cancelled',
        terminalReason: 'user_cancelled',
        errorMessage: 'Cancelled by user',
        platform: 'github',
      })
    ).toEqual({ label: 'Cancelled', message: 'This review was cancelled.' });
    expect(
      getCodeReviewCancellationCopy({
        status: 'interrupted',
        terminalReason: 'interrupted',
        errorMessage: 'container restarted',
        platform: 'github',
      })
    ).toEqual({ label: 'Interrupted', message: 'This review was interrupted.' });
  });

  it('does not resolve an inherited object member as copy', () => {
    expect(
      getCodeReviewCancellationCopy({
        status: 'cancelled',
        terminalReason: 'user_cancelled',
        errorMessage: 'constructor',
        platform: 'github',
      })
    ).toEqual({ label: 'Cancelled', message: 'This review was cancelled.' });
  });
});
