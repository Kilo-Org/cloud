import { useEffect } from 'react';

import { shouldStartAnalytics } from '@/lib/analytics-consent';
import { identifyUser, initPostHog } from '@/lib/analytics/posthog';
import { initAppsFlyer } from '@/lib/appsflyer';

type AnalyticsConsentGateState = {
  readonly hasToken: boolean;
  readonly consentChecked: boolean;
  readonly needsConsent: boolean;
  readonly email: string | undefined;
};

export function useAnalyticsConsentGate({
  hasToken,
  consentChecked,
  needsConsent,
  email,
}: AnalyticsConsentGateState): void {
  useEffect(() => {
    if (!shouldStartAnalytics({ hasToken, consentChecked, needsConsent })) {
      return;
    }

    initAppsFlyer();
    initPostHog();
    if (email) {
      identifyUser(email);
    }
  }, [hasToken, consentChecked, needsConsent, email]);
}
