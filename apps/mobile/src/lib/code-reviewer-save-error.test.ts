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

  it('gives a billing role the copy that offers the plan step', () => {
    expect(
      reviewerSaveFailure(
        makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE),
        SAVE_FALLBACK,
        true
      )
    ).toEqual({ message: i18n.t('common.organizationTrialEndedBilling'), retryable: false });
  });

  it('keeps the owner-naming copy for a reader who cannot change the plan', () => {
    const refusal = makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
    expect(reviewerSaveFailure(refusal, SAVE_FALLBACK, false)).toEqual({
      message: i18n.t('common.organizationTrialEnded'),
      retryable: false,
    });
    // The role defaults to the owner-naming copy for a caller that has not
    // resolved it yet.
    expect(reviewerSaveFailure(refusal, SAVE_FALLBACK)).toEqual({
      message: i18n.t('common.organizationTrialEnded'),
      retryable: false,
    });
  });

  it('carries the role into no other refusal', () => {
    const denied = makeError('FORBIDDEN', 'Not a reviewer manager');
    expect(reviewerSaveFailure(denied, SAVE_FALLBACK, true)).toEqual({
      message: SAVE_FALLBACK,
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
