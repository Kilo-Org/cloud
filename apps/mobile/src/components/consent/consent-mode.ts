import { i18n } from '@/i18n';

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
      primaryLabel: i18n.t('consent.back'),
      secondaryLabel: i18n.t('consent.revokeConsent'),
      destructiveLabel: i18n.t('consent.revokeConsent'),
      destructiveTitle: i18n.t('consent.revokeConsentTitle'),
    };
  }

  return {
    primaryLabel: i18n.t('consent.acceptAndContinue'),
    secondaryLabel: i18n.t('consent.decline'),
    destructiveLabel: i18n.t('consent.declineAndSignOut'),
    destructiveTitle: i18n.t('consent.declineTitle'),
  };
}
