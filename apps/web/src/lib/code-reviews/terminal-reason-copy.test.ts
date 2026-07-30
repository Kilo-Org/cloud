import { CODE_REVIEW_ACTION_REQUIRED_REASONS } from './action-required-shared';
import { getCodeReviewTerminalReasonCopy } from './terminal-reason-copy';

describe('getCodeReviewTerminalReasonCopy', () => {
  it('returns null for reasons without customer-facing copy', () => {
    expect(getCodeReviewTerminalReasonCopy(null)).toBeNull();
    expect(getCodeReviewTerminalReasonCopy(undefined)).toBeNull();
    expect(getCodeReviewTerminalReasonCopy('sandbox_error')).toBeNull();
    expect(getCodeReviewTerminalReasonCopy('assistant_failed')).toBeNull();
  });

  it('names the customer key for a byok rate limit', () => {
    expect(getCodeReviewTerminalReasonCopy('assistant_rate_limited_byok')).toEqual({
      label: 'Rate limited',
      message: 'Your provider API key hit its rate limit.',
      checkTitle: 'Kilo Code Review rate limited',
      checkSummary: 'Your provider API key hit its rate limit.',
    });
  });

  // 'managed' means the request used Kilo's credentials, which currently
  // conflates our upstream quota with our own abuse rules. Telling a customer to
  // check their key would be wrong in both cases.
  it('does not claim a customer key for managed or unqualified rate limits', () => {
    expect(getCodeReviewTerminalReasonCopy('assistant_rate_limited_managed')).toBeNull();
    expect(getCodeReviewTerminalReasonCopy('assistant_rate_limited')).toBeNull();
  });

  // This map is notification only. Action-required reasons additionally disable
  // Code Reviewer and own their own copy, so overlapping the two would give a
  // reason two competing messages.
  it('does not overlap with the action-required reasons', () => {
    const overlapping = CODE_REVIEW_ACTION_REQUIRED_REASONS.filter(reason =>
      getCodeReviewTerminalReasonCopy(reason)
    );

    expect(overlapping).toEqual([]);
  });

  it('ignores prototype keys', () => {
    expect(getCodeReviewTerminalReasonCopy('constructor')).toBeNull();
    expect(getCodeReviewTerminalReasonCopy('__proto__')).toBeNull();
    expect(getCodeReviewTerminalReasonCopy('toString')).toBeNull();
  });
});
