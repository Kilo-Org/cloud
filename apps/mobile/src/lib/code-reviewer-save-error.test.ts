import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { reviewerConfigSaveFailure } from '@/lib/code-reviewer-save-error';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

function makeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { data: { code, message } });
}

describe('reviewerConfigSaveFailure', () => {
  it('explains the organization trial gate and does not offer a retry', () => {
    expect(
      reviewerConfigSaveFailure(makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE))
    ).toEqual({ message: i18n.t('common.organizationTrialEnded'), retryable: false });
  });

  it('keeps the generic save line for an unexplained refusal, without a retry', () => {
    expect(reviewerConfigSaveFailure(makeError('FORBIDDEN', 'Not a reviewer manager'))).toEqual({
      message: i18n.t('codeReviewer.configSaveFailed'),
      retryable: false,
    });
  });

  it('offers a retry for a transport failure and for a server-side failure', () => {
    expect(reviewerConfigSaveFailure(new TypeError('Network request failed'))).toEqual({
      message: i18n.t('codeReviewer.configSaveFailed'),
      retryable: true,
    });
    expect(
      reviewerConfigSaveFailure(makeError('INTERNAL_SERVER_ERROR', 'Failed to update config'))
    ).toEqual({ message: i18n.t('codeReviewer.configSaveFailed'), retryable: true });
  });

  it('never shows the server sentence', () => {
    const failure = reviewerConfigSaveFailure(
      makeError('FORBIDDEN', ORGANIZATION_TRIAL_EXPIRED_MESSAGE)
    );
    expect(failure.message).not.toContain('trial has expired');
  });
});
