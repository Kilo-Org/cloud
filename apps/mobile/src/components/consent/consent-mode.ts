export type ConsentMode = 'onboarding' | 'review';

type ConsentActions = {
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
  readonly destructiveLabel: string;
  readonly destructiveTitle: string;
};

export function consentModeForSearchParam(mode: string | string[] | undefined): ConsentMode {
  return mode === 'review' ? 'review' : 'onboarding';
}

export function getConsentActions(mode: ConsentMode): ConsentActions {
  if (mode === 'review') {
    return {
      primaryLabel: 'Back',
      secondaryLabel: 'Revoke consent',
      destructiveLabel: 'Revoke consent',
      destructiveTitle: 'Revoke data sharing consent?',
    };
  }

  return {
    primaryLabel: 'Accept and continue',
    secondaryLabel: 'Decline',
    destructiveLabel: 'Decline and sign out',
    destructiveTitle: 'Decline data sharing?',
  };
}
