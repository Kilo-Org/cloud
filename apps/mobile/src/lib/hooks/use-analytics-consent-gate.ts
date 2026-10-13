import { useEffect } from 'react';

import { discardPostHog, identifyUser, initPostHog, resumePostHog } from '@/lib/analytics/posthog';
import { initAppsFlyer, resetAppsFlyerState } from '@/lib/appsflyer';
import {
  clearTelemetryDecision,
  currentAccountId,
  currentEpoch,
  setTelemetryDecision,
} from '@/lib/telemetry/controller';
import { purgePostHogPersistence } from '@/lib/telemetry/posthog-storage';

type AnalyticsConsentGateState = {
  /** True while the stored session is still being restored. */
  readonly authLoading: boolean;
  readonly hasToken: boolean;
  /** True while the signed-in user's id is still loading. */
  readonly userIdLoading: boolean;
  readonly consentChecked: boolean;
  /** True when the consent decision could not be read. */
  readonly consentCheckFailed: boolean;
  readonly needsConsent: boolean;
  readonly email: string | undefined;
  readonly accountId: string | undefined;
  readonly optionalConsent: boolean;
};

async function discardOptionalTelemetry(epoch: number): Promise<void> {
  await discardPostHog();
  if (currentEpoch() !== epoch) {
    return;
  }
  purgePostHogPersistence();
}

async function startOptionalTelemetry(epoch: number, email: string | undefined): Promise<void> {
  if (currentEpoch() !== epoch) {
    return;
  }
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
  authLoading,
  hasToken,
  userIdLoading,
  consentChecked,
  consentCheckFailed,
  needsConsent,
  email,
  accountId,
  optionalConsent,
}: AnalyticsConsentGateState): void {
  // Every cold start passes through this state while the session, the user
  // id, or the consent decision loads. With no decision yet, wait: the
  // discard purges the SDK storage files, so the next client would start with
  // a new anonymous id and send `Application Installed` on every launch. Once
  // a decision exists, an unresolved state still tears telemetry down.
  const resolving =
    authLoading ||
    userIdLoading ||
    (hasToken && accountId !== undefined && !consentChecked && !consentCheckFailed);
  useEffect(() => {
    if (resolving && currentAccountId() === undefined) {
      return;
    }
    if (!hasToken || !consentChecked || !accountId) {
      clearTelemetryDecision();
      const epoch = currentEpoch();
      resetAppsFlyerState();
      void discardOptionalTelemetry(epoch);
      return;
    }
    if (needsConsent || !optionalConsent) {
      setTelemetryDecision(accountId, false);
      const epoch = currentEpoch();
      resetAppsFlyerState();
      void discardOptionalTelemetry(epoch);
      return;
    }
    setTelemetryDecision(accountId, true);
    const epoch = currentEpoch();
    void startOptionalTelemetry(epoch, email);
  }, [resolving, hasToken, consentChecked, needsConsent, email, accountId, optionalConsent]);
}
