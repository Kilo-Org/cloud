import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { reviewerSaveFailure } from '@/lib/code-reviewer-save-error';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

function makeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { data: { code, message } });
}

const SAVE_FALLBACK = i18n.t('codeReviewer.configSaveFailed');
const UPDATE_FALLBACK = i18n.t('codeReviewer.updateFailed');

function saveFailure(error: unknown) {
  return reviewerSaveFailure(error, SAVE_FALLBACK);
}

describe('reviewerSaveFailure', () => {
  it('explains the organization trial gate and does not offer a retry', () => {
    expect(saveFailure(makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE))).toEqual({
      message: i18n.t('common.organizationTrialEnded'),
      retryable: false,
    });
  });

  it('keeps the caller’s generic line for an unexplained refusal, without a retry', () => {
    expect(saveFailure(makeError('FORBIDDEN', 'Not a reviewer manager'))).toEqual({
      message: SAVE_FALLBACK,
      retryable: false,
    });
    expect(
      reviewerSaveFailure(makeError('FORBIDDEN', 'Not a reviewer manager'), UPDATE_FALLBACK)
    ).toEqual({ message: UPDATE_FALLBACK, retryable: false });
  });

  it('offers a retry for a transport failure and for a server-side failure', () => {
    expect(saveFailure(new TypeError('Network request failed'))).toEqual({
      message: SAVE_FALLBACK,
      retryable: true,
    });
    expect(saveFailure(makeError('INTERNAL_SERVER_ERROR', 'Failed to update config'))).toEqual({
      message: SAVE_FALLBACK,
      retryable: true,
    });
  });

  it('never shows the server sentence', () => {
    const failure = saveFailure(makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE));
    expect(failure.message).not.toContain('trial has expired');
  });
});
