import { useEffect } from 'react';

import { shouldStartAppsFlyer } from '@/lib/appsflyer-consent';
import { initAppsFlyer } from '@/lib/appsflyer';

type AppsFlyerConsentGateState = {
  readonly hasToken: boolean;
  readonly consentChecked: boolean;
  readonly needsConsent: boolean;
};

export function useAppsFlyerConsentGate({
  hasToken,
  consentChecked,
  needsConsent,
}: AppsFlyerConsentGateState): void {
  useEffect(() => {
    if (!shouldStartAppsFlyer({ hasToken, consentChecked, needsConsent })) {
      return;
    }

    initAppsFlyer();
  }, [hasToken, consentChecked, needsConsent]);
}
