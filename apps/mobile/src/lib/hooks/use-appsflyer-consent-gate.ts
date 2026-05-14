import { requestTrackingPermissionsAsync } from 'expo-tracking-transparency';
import { useEffect } from 'react';
import { Platform } from 'react-native';

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

    async function startAppsFlyer() {
      if (Platform.OS === 'ios') {
        await requestTrackingPermissionsAsync();
      }
      initAppsFlyer();
    }

    void startAppsFlyer();
  }, [hasToken, consentChecked, needsConsent]);
}
