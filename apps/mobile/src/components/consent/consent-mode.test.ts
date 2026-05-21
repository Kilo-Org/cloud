import { describe, expect, it } from 'vitest';

import { consentModeForSearchParam, getConsentActions } from './consent-mode';

describe('consent mode', () => {
  it('uses accept and decline actions for first-time consent', () => {
    expect(getConsentActions('onboarding')).toEqual({
      primaryLabel: 'Accept and continue',
      secondaryLabel: 'Decline',
      destructiveLabel: 'Decline and sign out',
      destructiveTitle: 'Decline data sharing?',
    });
  });

  it('uses back and revoke actions when reviewing accepted consent', () => {
    expect(getConsentActions('review')).toEqual({
      primaryLabel: 'Back',
      secondaryLabel: 'Revoke consent',
      destructiveLabel: 'Revoke consent',
      destructiveTitle: 'Revoke data sharing consent?',
    });
  });

  it('maps only the review search param to review mode', () => {
    expect(consentModeForSearchParam('review')).toBe('review');
    expect(consentModeForSearchParam('anything-else')).toBe('onboarding');
    expect(consentModeForSearchParam(undefined)).toBe('onboarding');
  });
});
