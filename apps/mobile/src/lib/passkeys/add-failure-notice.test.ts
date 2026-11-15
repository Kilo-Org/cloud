import { describe, expect, it } from 'vitest';

import { addFailureNoticeKey } from './add-failure-notice';

describe('addFailureNoticeKey', () => {
  it('explains a sign-in that cannot manage passkeys', () => {
    // The credential cannot manage passkeys at all, so the notice replaces the
    // hint the withdrawn control would have named.
    expect(addFailureNoticeKey(false, 'device-unsupported')).toBe(
      'profile.passkeyManagementUnavailable'
    );
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
