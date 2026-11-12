import { useEffect } from 'react';

import {
  discardPostHog,
  identifyUser,
  initPostHog,
  isCaptureAllowed,
  livePostHogClient,
  resumePostHog,
} from '@/lib/analytics/posthog';
import { initAppsFlyer, resetAppsFlyerState } from '@/lib/appsflyer';
import {
  allowsOptional,
  clearTelemetryDecision,
  currentAccountId,
  currentEpoch,
  currentGeneration,
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

/**
 * Bring telemetry up for the signed-in account once the user has answered the
 * consent screen. The client only needs rebuilding when what it was built for
 * changes: another account (a different controller generation) or another
 * capture level. An unchanged build keeps its client and its queued events, and
 * a caller that only learned the email a moment later identifies the running
 * client instead.
 *
 * When a rebuild is needed, a client already running under another account, or
 * another consent state, is torn down first: its queue may hold events the
 * current consent forbids, and the capture options are constructor-only. A cold
 * start has no client, so its storage survives.
 *
 * `initPostHog` then creates the client the current consent allows — capture on
 * with optional consent, flags-only without it. A flags-only client still
 * resolves feature flags for the identified person, so a flag-gated surface
 * shows the rollout decision the web shows for that account.
 */
async function startTelemetry(epoch: number, email: string | undefined): Promise<void> {
  if (currentEpoch() !== epoch) {
    return;
  }
  const live = livePostHogClient();
  if (
    live &&
    live.generation === currentGeneration() &&
    live.captureAllowed === isCaptureAllowed()
  ) {
    if (email !== undefined && live.identifiedEmail !== email) {
      identifyUser(email);
    }
    return;
  }
  if (live) {
    await discardOptionalTelemetry(epoch);
    if (currentEpoch() !== epoch) {
      return;
    }
  }
  await resumePostHog();
  if (currentEpoch() !== epoch) {
    return;
  }
  if (allowsOptional()) {
    initAppsFlyer();
  }
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
    if (needsConsent) {
      // The consent screen is up and the user has not answered: start nothing,
      // capture or flag evaluation. The answer arrives as `needsConsent: false`.
      setTelemetryDecision(accountId, false);
      const epoch = currentEpoch();
      resetAppsFlyerState();
      void discardOptionalTelemetry(epoch);
      return;
    }
    if (!optionalConsent) {
      setTelemetryDecision(accountId, false);
      const epoch = currentEpoch();
      resetAppsFlyerState();
      void startTelemetry(epoch, email);
      return;
    }
    setTelemetryDecision(accountId, true);
    const epoch = currentEpoch();
    void startTelemetry(epoch, email);
  }, [resolving, hasToken, consentChecked, needsConsent, email, accountId, optionalConsent]);
}
