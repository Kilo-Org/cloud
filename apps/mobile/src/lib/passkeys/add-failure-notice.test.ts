import { describe, expect, it } from 'vitest';

import { addFailureNoticeKey } from './add-failure-notice';

describe('addFailureNoticeKey', () => {
  it('explains an unavailable add with the browser-only notice', () => {
    // The account cannot enroll from the app, so the notice replaces the hint
    // the withdrawn control would have named.
    expect(addFailureNoticeKey(false, 'unavailable')).toBe('profile.passkeyAddUnavailable');
  });

  it('explains a device that cannot create passkeys', () => {
    expect(addFailureNoticeKey(false, null)).toBe('profile.passkeyAddUnsupported');
    expect(addFailureNoticeKey(false, 'unsupported')).toBe('profile.passkeyAddUnsupported');
  });

  it('reports a failed attempt while the control is still offered', () => {
    expect(addFailureNoticeKey(true, 'failed')).toBe('profile.passkeyAddFailed');
  });

  it('stays quiet when the offered control has nothing to report', () => {
    expect(addFailureNoticeKey(true, null)).toBeNull();
    expect(addFailureNoticeKey(true, 'unsupported')).toBeNull();
  });
});
