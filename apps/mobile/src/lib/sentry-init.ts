import * as Sentry from '@sentry/react-native';
import { isRunningInExpoGo } from 'expo';

import { SENTRY_ENVIRONMENT } from '@/lib/config';
import { SENTRY_DSN } from '@/lib/sentry-dsn';
import { sentryOptionsForConsent } from '@/lib/sentry-consent';
import { applySentryContext } from '@/lib/sentry-context';
import { scrubBreadcrumb, scrubEvent } from '@/lib/telemetry/sentry-scrub';
import { resolveSentryEnvironment } from '@/lib/sentry-environment';

const expoRouterIntegration = Sentry.expoRouterIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
});

/** Test-only extras: transport and transportOptions are forwarded into init
 *  so a transport spy can observe the Sentry pipeline (slice P3-AH-16a). */
type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
export type SentryInitExtras = Pick<SentryInitOptions, 'transport' | 'transportOptions'>;

// DEC-02 consent rule: crash and error reporting is mandatory, so
// `initSentry(false)` runs at module scope — a crash during bootstrap
// must still be reported. The optional group is `tracesSampleRate` plus
// MASKED session replay and error screenshots (DEC-02 amendment, owner
// decision 2026-08-17); the replay integration is only registered once
// optional consent is accepted, so no replay code runs before the
// decision. The Sentry context module reapplies identity and global tags after
// every init, and auth sign-out clears its canonical identity state.
// `enableTombstone` is Android 12+ only; NDK stays on for older devices.
// `enableMetricKit` is iOS 15+ only. App-hang tracking stays off so MetricKit
// hangs are not reported twice. Native init in the Expo plugin captures
// crashes before JS loads.
//
// In-scope core-loop spans (tracesSampleRate > 0 when optional consent is true):
// — `app.start.cold` / `app.start.warm` (TTID / TTFD via React Navigation
//   integration). The authoritative per-launch timing metric is the PostHog
//   `app_startup` event in src/lib/startup-timing.ts.
export function initSentry(optionalConsented: boolean, extras?: SentryInitExtras) {
  Sentry.init({
    dsn: SENTRY_DSN,

    enabled: true,

    sendDefaultPii: false,

    enableTombstone: true,
    enableMetricKit: true,
    enableAppHangTracking: false,

    environment: resolveSentryEnvironment(SENTRY_ENVIRONMENT, __DEV__),
    ...sentryOptionsForConsent(optionalConsented),
    ...extras,

    integrations: optionalConsented
      ? [
          expoRouterIntegration,
          Sentry.deeplinkIntegration(),
          Sentry.mobileReplayIntegration({
            maskAllText: true,
            maskAllImages: true,
            maskAllVectors: true,
          }),
        ]
      : [expoRouterIntegration, Sentry.deeplinkIntegration()],
    enableNativeFramesTracking: false,

    beforeSend: scrubEvent as NonNullable<Parameters<typeof Sentry.init>[0]>['beforeSend'],
    beforeBreadcrumb: scrubBreadcrumb as NonNullable<
      Parameters<typeof Sentry.init>[0]
    >['beforeBreadcrumb'],

    spotlight: __DEV__,
  });
  applySentryContext();
}
