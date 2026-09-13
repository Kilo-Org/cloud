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
type SentryIntegration = Extract<
  NonNullable<SentryInitOptions['integrations']>,
  readonly unknown[]
>[number];

// Integrations lifecycle (why `integrations` below is a function, and why the
// consented profiler carries a unique name): the RN SDK always MERGES its
// default integrations into the explicit list (sdk.js -> core's
// getIntegrationsToSetup), and the default list auto-registers HermesProfiling
// whenever `profilesSampleRate` is a number — 0 included
// (integrations/default.js). Core then gates every integration's `setupOnce`
// on a process-global `installedIntegrations` name list that no later
// `Sentry.init()` resets (@sentry/core integration.js). Left alone, the
// module-scope declined init would consume the once-only 'HermesProfiling'
// slot and the consented re-init's profiler would never attach its
// spanStart/spanEnd/beforeEnvelope handlers to the new client. So the
// resolver drops the default HermesProfiling instance in BOTH branches —
// which also keeps the consented merge from carrying two live profilers, since
// the Hermes profiler is a process singleton — and the consented instance is
// registered under a name unique per init, so accept → revoke → re-accept
// re-runs setupOnce on every fresh client.
let profilerRegistrations = 0;

// DEC-02 consent rule: crash and error reporting is mandatory, so
// `initSentry(false)` runs at module scope — a crash during bootstrap
// must still be reported. The optional group is `tracesSampleRate` plus
// MASKED session replay, JS profiling (`profilesSampleRate`, Hermes) and
// error screenshots (DEC-02 amendment, owner
// decision 2026-08-17); the replay and profiling integrations are only
// registered once optional consent is accepted (the resolver below also drops
// the default profiler instance, so no profiler code runs before the
// decision). The Sentry context module reapplies identity and global tags after
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
//
export function initSentry(optionalConsented: boolean, extras?: SentryInitExtras) {
  const userIntegrations: SentryIntegration[] = optionalConsented
    ? [
        expoRouterIntegration,
        // Attaches a thrown error's own properties (e.g. tRPC `data`) to the
        // event; `beforeSend`/`scrubEvent` still redacts token-shaped extras.
        Sentry.extraErrorDataIntegration(),
        Sentry.deeplinkIntegration(),
        Sentry.mobileReplayIntegration({
          maskAllText: true,
          maskAllImages: true,
          maskAllVectors: true,
        }),
        // Registered explicitly (not via the default list) under a name
        // unique per init — see the integrations lifecycle note above.
        {
          ...Sentry.hermesProfilingIntegration(),
          name: `HermesProfiling#${(profilerRegistrations += 1)}`,
        },
      ]
    : [
        expoRouterIntegration,
        // Error reporting is mandatory (DEC-02), so extra error data is
        // attached even before optional consent is decided.
        Sentry.extraErrorDataIntegration(),
        Sentry.deeplinkIntegration(),
      ];

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

    integrations: defaults => [
      // Drop the default HermesProfiling instance the RN SDK merges in
      // whenever `profilesSampleRate` is a number (0 included) — the declined
      // branch must not consume its once-only setupOnce slot, and the
      // consented branch registers its own uniquely named instance.
      ...defaults.filter(integration => integration.name !== 'HermesProfiling'),
      ...userIntegrations,
    ],
    enableNativeFramesTracking: false,

    beforeSend: scrubEvent as NonNullable<Parameters<typeof Sentry.init>[0]>['beforeSend'],
    beforeBreadcrumb: scrubBreadcrumb as NonNullable<
      Parameters<typeof Sentry.init>[0]
    >['beforeBreadcrumb'],

    spotlight: __DEV__,
  });
  applySentryContext();
}
