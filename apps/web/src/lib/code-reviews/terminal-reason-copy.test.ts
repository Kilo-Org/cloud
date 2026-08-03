import { CODE_REVIEW_TERMINAL_REASONS } from '@kilocode/db/schema-types';
import { CODE_REVIEW_ACTION_REQUIRED_REASONS } from './action-required-shared';
import { getCodeReviewTerminalReasonCopy } from './terminal-reason-copy';

/**
 * Derived rather than hardcoded so the invariants below automatically cover any
 * reason added to the copy map later.
 */
const REASONS_WITH_COPY = CODE_REVIEW_TERMINAL_REASONS.filter(reason =>
  getCodeReviewTerminalReasonCopy(reason)
);

describe('getCodeReviewTerminalReasonCopy', () => {
  it('returns null for reasons without customer-facing copy', () => {
    expect(getCodeReviewTerminalReasonCopy(null)).toBeNull();
    expect(getCodeReviewTerminalReasonCopy(undefined)).toBeNull();
    expect(getCodeReviewTerminalReasonCopy('sandbox_error')).toBeNull();
    expect(getCodeReviewTerminalReasonCopy('assistant_failed')).toBeNull();
  });

  it('names the customer key for a byok rate limit', () => {
    expect(getCodeReviewTerminalReasonCopy('assistant_rate_limited_byok')).toMatchObject({
      label: 'Rate limited',
      message: 'Your provider API key hit its rate limit.',
      checkTitle: 'Kilo Code Review rate limited',
      checkSummary: 'Your provider API key hit its rate limit.',
    });
  });

  // The summary body replaces the PR comment in place. Losing the marker would
  // orphan the existing comment and post a duplicate on the next run, because
  // that marker is how the comment is found.
  it('starts every summary body with the kilo-review marker', () => {
    for (const reason of REASONS_WITH_COPY) {
      const copy = getCodeReviewTerminalReasonCopy(reason);
      expect(copy?.summaryBody.startsWith('<!-- kilo-review -->')).toBe(true);
    }
  });

  // This copy is published to the pull request, which may be a public
  // repository, so it must read as finished prose rather than a stub.
  it('gives every summary body real content', () => {
    for (const reason of REASONS_WITH_COPY) {
      const copy = getCodeReviewTerminalReasonCopy(reason);
      expect(copy?.summaryBody.replace('<!-- kilo-review -->', '').trim().length).toBeGreaterThan(
        40
      );
    }
  });

  it('explains that the byok rate limit is not retried', () => {
    const copy = getCodeReviewTerminalReasonCopy('assistant_rate_limited_byok');

    expect(copy?.summaryBody).toContain('did not run');
    expect(copy?.summaryBody).toContain('does not retry automatically');
    // Inline comments are deliberately left in place, so the summary has to say
    // they are stale rather than let them read as current findings.
    expect(copy?.summaryBody).toContain('inline comments');
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
