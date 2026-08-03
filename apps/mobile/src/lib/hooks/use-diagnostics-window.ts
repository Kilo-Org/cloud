import { useEffect, useState } from 'react';

import {
  FEATURE_FLAG_DEEP_DIAGNOSTICS,
  useFeatureFlag,
  useFeatureFlagPayloadJson,
} from '@/lib/analytics/posthog';
import { hasAcceptedConsent, subscribeToConsentChanges } from '@/lib/consent';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { selectDiagnosticsWindowActive } from '@/lib/list-diagnostics';

export function useDiagnosticsWindow(): boolean {
  const flagEnabled = useFeatureFlag(FEATURE_FLAG_DEEP_DIAGNOSTICS, false);
  const payloadJson = useFeatureFlagPayloadJson(FEATURE_FLAG_DEEP_DIAGNOSTICS);
  const { userId } = useCurrentUserId({ enabled: true });

  const [consentGranted, setConsentGranted] = useState(false);
  useEffect(() => {
    if (!userId) {
      setConsentGranted(false);
      return undefined;
    }
    let isActive = true;
    const read = (): void => {
      void (async () => {
        try {
          const accepted = await hasAcceptedConsent(userId);
          if (isActive) {
            setConsentGranted(accepted);
          }
        } catch {
          if (isActive) {
            setConsentGranted(false);
          }
        }
      })();
    };
    read();
    const unsubscribe = subscribeToConsentChanges(read);
    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [userId]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!flagEnabled || !consentGranted) {
      return undefined;
    }
    // Read the clock immediately: the inputs just changed, and the stored
    // value can be hours old on a long-lived mount.
    setNowMs(Date.now());
    // 60 s granularity — the window ends within a minute of `until`.
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);
    return () => {
      clearInterval(id);
    };
  }, [flagEnabled, consentGranted, payloadJson]);

  return selectDiagnosticsWindowActive({ flagEnabled, consentGranted, payloadJson, nowMs });
}
