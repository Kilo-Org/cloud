import { useEffect } from 'react';

import { shouldStartAnalytics } from '@/lib/analytics-consent';
import { discardPostHog, identifyUser, initPostHog, resumePostHog } from '@/lib/analytics/posthog';
import { initAppsFlyer, resetAppsFlyerState } from '@/lib/appsflyer';
import {
  clearTelemetryDecision,
  currentEpoch,
  setTelemetryDecision,
} from '@/lib/telemetry/controller';
import { purgePostHogPersistence } from '@/lib/telemetry/posthog-storage';

type AnalyticsConsentGateState = {
  readonly hasToken: boolean;
  readonly consentChecked: boolean;
  readonly needsConsent: boolean;
  readonly email: string | undefined;
  readonly accountId: string | undefined;
  readonly optionalConsent: boolean;
};

export async function discardOptionalTelemetry(epoch: number): Promise<void> {
  await discardPostHog();
  if (currentEpoch() !== epoch) {
    return;
  }
  purgePostHogPersistence();
}

export async function startOptionalTelemetry(epoch: number, email: string | undefined): Promise<void> {
  await resumePostHog();
  if (currentEpoch() !== epoch) {
    return;
  }
  initAppsFlyer();
  initPostHog();
  if (email) {
    identifyUser(email);
  }
}

export function useAnalyticsConsentGate({
  hasToken,
  consentChecked,
  needsConsent,
  email,
  accountId,
  optionalConsent,
}: AnalyticsConsentGateState): void {
  useEffect(() => {
    if (!shouldStartAnalytics({ hasToken, consentChecked, needsConsent }) || !accountId) {
      clearTelemetryDecision();
      return;
    }
    if (!optionalConsent) {
      setTelemetryDecision(accountId, false);
      const epoch = currentEpoch();
      resetAppsFlyerState();
      void discardOptionalTelemetry(epoch);
      return;
    }
    setTelemetryDecision(accountId, true);
    const epoch = currentEpoch();
    void startOptionalTelemetry(epoch, email);
  }, [hasToken, consentChecked, needsConsent, email, accountId, optionalConsent]);
}
