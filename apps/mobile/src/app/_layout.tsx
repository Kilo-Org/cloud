/* eslint-disable max-lines -- root layout bootstrap: auth/consent/update gating, notification wiring, theme readiness gate, and Sentry init are kept together */
import '../global.css';
import '@/lib/cloud-agent-runtime';

import { installE2EWebSocketLatency } from '@/lib/e2e-ws-latency';

// Deep imports of only the two weights this app renders. The package barrel
// (`@expo-google-fonts/jetbrains-mono`) require()s all 16 weights at module
// scope and Metro does not tree-shake, so importing it ships ~1.63MB of unused
// font bytes. The per-weight subpaths pull only the two used `.ttf` files.
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import { JetBrainsMono_600SemiBold } from '@expo-google-fonts/jetbrains-mono/600SemiBold';
import * as Sentry from '@sentry/react-native';
import { isRunningInExpoGo } from 'expo';
import { loadAsync, useFonts } from 'expo-font';
import {
  ErrorBoundary as ExpoRouterErrorBoundary,
  type Href,
  Slot,
  ThemeProvider,
  useGlobalSearchParams,
  usePathname,
  useRouter,
  useSegments,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { AnimatedSplashOverlay } from '@/components/animated-splash-overlay';
import { AppRootProviders } from '@/components/app-root-providers';
import { BootstrapErrorScreen } from '@/components/bootstrap-error-screen';
import { announceForA11y, moveA11yFocus } from '@/lib/a11y/announce';
import { useAuth } from '@/lib/auth/auth-context';
import { consentModeForSearchParam } from '@/components/consent/consent-mode';
import { checkConsentGate } from '@/lib/consent-gate';
import { subscribeToConsentChanges } from '@/lib/consent';
import { shouldStartAnalytics } from '@/lib/analytics-consent';
import { isPostHogReady, subscribeToPostHogReady } from '@/lib/analytics/posthog';
import { drainStartupTimings } from '@/lib/startup-drain';
import { markStartup, markStartupComplete } from '@/lib/startup-timing';
import { prefetchCurrentUser } from '@/lib/startup-prefetch';
import { useAnalyticsConsentGate } from '@/lib/hooks/use-analytics-consent-gate';
import { useForceUpdate } from '@/lib/hooks/use-force-update';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useScreenTracking } from '@/lib/hooks/use-screen-tracking';
import { useNavigationTheme } from '@/lib/hooks/use-theme-colors';
import {
  applyThemePreference,
  preloadThemePreference,
  useThemePreference,
} from '@/lib/hooks/use-theme-preference';
import { useTrackingPermissionPrompt } from '@/lib/hooks/use-tracking-permission-prompt';
import { captureLaunchDeepLink, getPendingDeepLink } from '@/lib/deep-link-launch';
import {
  checkInitialNotification,
  setupNotificationHandler,
  setupNotificationResponseHandler,
} from '@/lib/notifications';
import { restorePersistedCacheOnColdStart } from '@/lib/persist/read-cache';
import { queryClient } from '@/lib/query-client';
import { resolvePendingNavigation } from '@/lib/pending-navigation';
import {
  isShellReadyForShare,
  resolvePendingShareNavigation,
  resolveSupersededPendingShareId,
} from '@/lib/pending-share-navigation';
import {
  clearSharePayload,
  discardUnstoredSharePayload,
  normalizeShareIntent,
  putSharePayload,
  type ShareId,
  type SharePayload,
} from '@/lib/share-payload';
import { SENTRY_ENVIRONMENT } from '@/lib/config';
import { SENTRY_DSN } from '@/lib/sentry-dsn';
import { sentryOptionsForConsent } from '@/lib/sentry-consent';
import { scrubBreadcrumb, scrubEvent } from '@/lib/telemetry/sentry-scrub';
import { resolveSentryEnvironment } from '@/lib/sentry-environment';
import { useSentryConsentSync } from '@/lib/hooks/use-sentry-consent-sync';

const expoRouterIntegration = Sentry.expoRouterIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
});

// No-op unless E2E_LATENCY_WS_MS is set at bundle time (see lib/e2e-ws-latency).
installE2EWebSocketLatency();

// DEC-02 consent rule: crash and error reporting is mandatory, so
// `initSentry(false)` runs at module scope — a crash during bootstrap
// must still be reported. The optional group is `tracesSampleRate` plus
// MASKED session replay and error screenshots (DEC-02 amendment, owner
// decision 2026-08-17); the replay integration is only registered once
// optional consent is accepted, so no replay code runs before the
// decision. Account identity is cleared by step 7's `Sentry.setUser(null)`.
// `enableTombstone` is Android 12+ only; NDK stays on for older devices.
// `enableMetricKit` is iOS 15+ only. App-hang tracking stays off so MetricKit
// hangs are not reported twice. Native init in the Expo plugin captures
// crashes before JS loads.
//
// In-scope core-loop spans (tracesSampleRate > 0 when optional consent is true):
// — `app.start.cold` / `app.start.warm` (TTID / TTFD via React Navigation
//   integration). The authoritative per-launch timing metric is the PostHog
//   `app_startup` event in src/lib/startup-timing.ts.
function initSentry(optionalConsented: boolean) {
  Sentry.init({
    dsn: SENTRY_DSN,

    enabled: true,

    sendDefaultPii: false,

    enableTombstone: true,
    enableMetricKit: true,
    enableAppHangTracking: false,

    environment: resolveSentryEnvironment(SENTRY_ENVIRONMENT, __DEV__),
    ...sentryOptionsForConsent(optionalConsented),

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
}

initSentry(false);

// Kick the font load off at module scope so it overlaps JS bootstrap; the
// same family names make `loadAsync` dedupe with the `useFonts` call in
// RootLayoutNav. A failure here is ignored — `useFonts` stays the owner of
// `fontsError`.
function preloadStartupFonts(): void {
  void (async () => {
    try {
      await loadAsync({ JetBrainsMono_500Medium, JetBrainsMono_600SemiBold });
    } catch {
      // useFonts stays the owner of fontsError.
    }
  })();
}

void SplashScreen.preventAutoHideAsync();
setupNotificationHandler();
checkInitialNotification();
captureLaunchDeepLink();
prefetchCurrentUser();
preloadThemePreference();
preloadStartupFonts();

function RootLayoutNav() {
  const { token, isLoading: authLoading, signOut } = useAuth();
  const { updateRequired } = useForceUpdate();
  const [fontsLoaded, fontsError] = useFonts({
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
  });
  const segments = useSegments();
  const pathname = usePathname();
  const { mode } = useGlobalSearchParams<{ mode?: string }>();
  const router = useRouter();
  const { preference: themePreference, hasLoaded: themeHasLoaded } = useThemePreference();
  const {
    userId,
    email,
    isLoading: userIdLoading,
    isError: userIdError,
    refetch: refetchUserId,
  } = useCurrentUserId({ enabled: token != null });
  const [consentChecked, setConsentChecked] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [optionalConsent, setOptionalConsentState] = useState(false);
  const [consentCheckError, setConsentCheckError] = useState<unknown>(null);
  const [consentCheckRetryKey, setConsentCheckRetryKey] = useState(0);
  // Flipped by every splash-hide site below, so the app_startup drain can
  // depend on "startup finished" as an ordinary dependency.
  const [startupFinished, setStartupFinished] = useState(false);
  // Reactive snapshot so the drain effect re-triggers when the PostHog
  // client becomes ready after async init.
  const postHogReady = useSyncExternalStore(subscribeToPostHogReady, isPostHogReady);

  useEffect(() => {
    if (fontsError) {
      Sentry.captureException(fontsError);
    }
  }, [fontsError]);

  // Cold-start read-cache restore: best effort, never blocks startup. Starts
  // before the auth gate resolves so allowlisted queries can hydrate under
  // the splash; the authenticated mount abandons or rescopes it on identity.
  useEffect(() => {
    void restorePersistedCacheOnColdStart(queryClient);
  }, []);

  useSentryConsentSync(consentChecked && !needsConsent && optionalConsent, initSentry);

  const fontsReady = fontsLoaded || fontsError !== null;
  // The force-update check is deliberately absent: it is a live network round
  // trip that fails open in every branch (lib/hooks/use-force-update), so
  // holding first paint for it only ever costs time. `updateRequired` starts
  // false, first paint happens, and the effect below routes to /force-update
  // if the check later says an update is required.
  const isLoading = authLoading || !fontsReady || !themeHasLoaded;

  // Startup phase timings (lib/startup-timing). Idempotent per mark, so this
  // effect re-runs freely as gates settle. `userIdLoading` is false while the
  // query is disabled, so it only counts once there is a token.
  useEffect(() => {
    if (!authLoading) {
      markStartup('auth_ready');
    }
    if (fontsReady) {
      markStartup('fonts_ready');
    }
    if (themeHasLoaded) {
      markStartup('theme_ready');
    }
    if (token != null && !userIdLoading) {
      markStartup('user_ready');
    }
    if (consentChecked) {
      markStartup('consent_ready');
    }
  }, [authLoading, fontsReady, themeHasLoaded, token, userIdLoading, consentChecked]);

  useEffect(() => {
    if (themeHasLoaded) {
      applyThemePreference(themePreference);
    }
  }, [themeHasLoaded, themePreference]);
  const inAuthGroup = segments[0] === '(auth)';
  const inForceUpdate = segments[0] === 'force-update';
  const onConsentRoute = pathname === '/consent' || pathname === '/consent-details';
  const onConsentReviewRoute = onConsentRoute && consentModeForSearchParam(mode) === 'review';
  const onGateRoute = (segments as readonly string[]).includes('share-gate');
  const {
    hasShareIntent,
    shareIntent,
    resetShareIntent,
    error: shareIntentError,
  } = useShareIntentContext();
  // expo-share-intent rebuilds resetShareIntent every render; keep it out of
  // the ingest/error effect deps via ref (same pattern as share-prefill.ts).
  const resetShareIntentRef = useRef(resetShareIntent);
  resetShareIntentRef.current = resetShareIntent;
  const [pendingShareId, setPendingShareId] = useState<ShareId | null>(null);
  // Mirror pendingShareId so the ingest effect can release a superseded share
  // without reading stale state or adding the id to effect deps.
  const pendingShareIdRef = useRef(pendingShareId);
  pendingShareIdRef.current = pendingShareId;

  // Paired with isShellReadyForShare — keep the success-tail guards in lockstep.
  const isShellReady = isShellReadyForShare({
    hasToken: token != null,
    isLoading,
    updateRequired,
    inAuthGroup,
    inForceUpdate,
    userIdLoading,
    userIdError,
    consentCheckError: consentCheckError != null,
    consentChecked,
    needsConsent,
    onConsentRoute,
    onConsentReviewRoute,
  });

  useEffect(() => {
    let cancelled = false;

    async function checkConsent() {
      if (!token || !userId) {
        setConsentChecked(false);
        setNeedsConsent(false);
        setOptionalConsentState(false);
        setConsentCheckError(null);
        return;
      }

      const result = await checkConsentGate(userId);
      if (cancelled) {
        return;
      }

      if (result.status === 'error') {
        Sentry.captureException(result.error);
        setNeedsConsent(false);
        setOptionalConsentState(false);
        setConsentChecked(false);
        setConsentCheckError(result.error);
        return;
      }

      if (result.status === 'accepted') {
        setOptionalConsentState(result.optional);
      } else {
        setOptionalConsentState(false);
      }
      setConsentCheckError(null);
      setNeedsConsent(result.status === 'needs-consent');
      setConsentChecked(true);
    }

    void checkConsent();

    return () => {
      cancelled = true;
    };
  }, [token, userId, consentCheckRetryKey]);

  useEffect(() => {
    if (!token || !userId) {
      return undefined;
    }

    const unsubscribe = subscribeToConsentChanges(change => {
      if (change.userId !== userId) {
        return;
      }

      setNeedsConsent(!change.hasAccepted);
      setOptionalConsentState(change.optional);
      setConsentChecked(true);
    });

    return unsubscribe;
  }, [token, userId]);

  useTrackingPermissionPrompt(
    optionalConsent &&
      shouldStartAnalytics({ hasToken: token != null, consentChecked, needsConsent })
  );
  useAnalyticsConsentGate({
    hasToken: token != null,
    consentChecked,
    needsConsent,
    email,
    accountId: userId,
    optionalConsent,
  });
  // Screen capture must wait for consent: analytics eligibility is decided
  // only after the account's consent decision has loaded without error.
  const bootstrapSettled = token != null && consentChecked && !needsConsent && !consentCheckError;
  useScreenTracking(bootstrapSettled);

  useEffect(() => {
    if (shareIntentError) {
      Sentry.captureException(new Error(shareIntentError));
      toast.error("Couldn't read the shared content");
      resetShareIntentRef.current();
    }
  }, [shareIntentError]);

  // Keyed per shareIntent identity so a newer intent cancels and supersedes
  // an in-flight ingest. Success/failure reset for the happy path lives here
  // (gate must never reset); the shareIntentError effect also resets on the
  // error path. Calls go through resetShareIntentRef so the unstable context
  // function stays out of the deps.
  useEffect(() => {
    if (!hasShareIntent) {
      return undefined;
    }

    let cancelled = false;

    const ingestShareIntent = async () => {
      try {
        const payload: SharePayload = await normalizeShareIntent(shareIntent);
        if (cancelled) {
          // Superseded mid-copy: never stored, so no lifecycle path can clean it.
          discardUnstoredSharePayload(payload);
          return;
        }
        const shareId = putSharePayload(payload);
        resetShareIntentRef.current();
        // Latest-wins: a superseded pending share is released — never silently orphaned.
        const superseded = resolveSupersededPendingShareId(pendingShareIdRef.current, shareId);
        if (superseded !== null) {
          clearSharePayload(superseded);
        }
        setPendingShareId(shareId);
      } catch (error) {
        if (cancelled) {
          return;
        }
        Sentry.captureException(error);
        toast.error("Couldn't read the shared content");
        resetShareIntentRef.current();
      }
    };

    void ingestShareIntent();

    return () => {
      cancelled = true;
    };
  }, [hasShareIntent, shareIntent]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (updateRequired) {
      if (!inForceUpdate) {
        router.replace('/force-update');
      } else {
        markStartupComplete('force-update');
        setStartupFinished(true);
      }
      return;
    }

    if (inForceUpdate) {
      router.replace('/(app)');
      return;
    }

    if (!token) {
      if (inAuthGroup) {
        markStartupComplete('login');
        setStartupFinished(true);
      } else {
        router.replace('/(auth)/login');
      }
    } else {
      if (userIdError) {
        markStartupComplete('user-error');
        setStartupFinished(true);
        return;
      }

      if (consentCheckError) {
        markStartupComplete('consent-error');
        setStartupFinished(true);
        return;
      }

      if (userIdLoading || !consentChecked) {
        return;
      }

      if (needsConsent) {
        if (onConsentRoute) {
          markStartupComplete('consent');
          setStartupFinished(true);
        } else {
          router.replace('/(app)/consent' as Href);
        }
        return;
      }

      if ((onConsentRoute && !onConsentReviewRoute) || inAuthGroup) {
        router.replace('/(app)');
        return;
      }

      markStartupComplete('app');
      setStartupFinished(true);
      // Navigate to pending deep link (cold start universal link / notification tap)
      const pendingNavigation = resolvePendingNavigation(getPendingDeepLink());
      if (pendingNavigation) {
        router.navigate(pendingNavigation.href as Href);
      }
      // Share-gate open is owned by the pendingShareId effect + isShellReadyForShare.
    }
  }, [
    token,
    isLoading,
    updateRequired,
    inAuthGroup,
    inForceUpdate,
    router,
    userIdLoading,
    userIdError,
    consentCheckError,
    consentChecked,
    needsConsent,
    onConsentRoute,
    onConsentReviewRoute,
  ]);

  // Declared after the auth effect so that on the same flush a pending
  // notification navigate runs first and the share gate opens on top.
  useEffect(() => {
    if (pendingShareId === null || !isShellReady) {
      return;
    }

    const navigation = resolvePendingShareNavigation({
      shareId: pendingShareId,
      onGateRoute,
    });
    if (!navigation) {
      return;
    }

    if (navigation.mode === 'replace') {
      router.replace(navigation.href as Href);
    } else {
      router.push(navigation.href as Href);
    }
    setPendingShareId(null);
  }, [pendingShareId, isShellReady, onGateRoute, router]);

  // One `app_startup` event per launch, delegated to a drain helper so
  // tests can drive the real guard logic without mounting the full layout.
  // Whichever gate settles last triggers the send. Because
  // `useSyncExternalStore` re-renders when the PostHog client becomes ready,
  // this effect re-triggers even after consent/startup has already resolved.
  //
  // Must stay the LAST effect here — `takeStartupTimings()` is one-shot.
  // Signed-out launches are never reported.
  useEffect(() => {
    if (!startupFinished) {
      return;
    }
    drainStartupTimings({
      hasToken: token != null,
      consentChecked,
      needsConsent,
      optionalConsent,
      postHogReady,
    });
  }, [startupFinished, token, consentChecked, needsConsent, optionalConsent, postHogReady]);

  const needsForceUpdate = updateRequired && !inForceUpdate;
  const showingForceUpdate = updateRequired && inForceUpdate;
  const needsAuth = !token && !inAuthGroup;
  const needsAppRedirect = token != null && inAuthGroup;
  const hasUserBootstrapError = token != null && userIdError;
  const hasConsentBootstrapError = token != null && consentCheckError !== null;
  const hasBootstrapError = hasUserBootstrapError || hasConsentBootstrapError;
  const consentLoading =
    token != null && !consentChecked && !inAuthGroup && !inForceUpdate && !onConsentRoute;
  const needsConsentRedirect = consentChecked && needsConsent && !onConsentRoute;

  const needsRedirect =
    !isLoading &&
    (needsForceUpdate ||
      (!showingForceUpdate && (needsAuth || needsAppRedirect || needsConsentRedirect)));

  // Always keep Slot mounted so Expo Router's navigation tree stays
  // initialised — returning null unmounts it and breaks router.replace.
  // The native splash screen covers everything during initial load, and
  // opacity 0 hides the wrong screen during redirects.
  const hidden =
    !hasUserBootstrapError &&
    !hasConsentBootstrapError &&
    (isLoading || needsRedirect || consentLoading);

  // Hidden root-route entry contract (D17): while `hidden`, the wrapper leaves
  // both accessibility trees. On the hidden → visible transition,
  // `announceForA11y` is the deterministic entry context for screen-reader
  // users, and the wrapper focus is best-effort (`moveA11yFocus` returns false
  // when the platform declines — no retry), deferred to the next frame so the
  // revealed tree is measurable. Per-screen heading/first-control focus is
  // owned by the screens themselves; the gate cannot know the active screen's
  // heading.
  //
  // The transition is skipped while a bootstrap error is shown: the wrapper
  // is unmounted then (the error screen replaces it), so "Content ready"
  // would be a false announcement and the wrapper focus has no target. The
  // cleanup cancels the pending frame, which React runs before any later
  // render's frame can fire, so an interrupted reveal never focuses a stale
  // wrapper.
  const wrapperRef = useRef<View>(null);
  const wasHiddenRef = useRef(hidden);
  useEffect(() => {
    const wasHidden = wasHiddenRef.current;
    wasHiddenRef.current = hidden;
    if (!wasHidden || hidden || hasBootstrapError) {
      return undefined;
    }
    announceForA11y('Content ready');
    const frame = requestAnimationFrame(() => {
      moveA11yFocus(wrapperRef);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [hidden, hasBootstrapError]);

  if (hasUserBootstrapError) {
    return (
      <BootstrapErrorScreen
        title="Could not load your account"
        description="Check your connection and try again."
        primaryLabel="Retry"
        primaryAccessibilityLabel="Retry loading account"
        onPrimaryPress={refetchUserId}
        secondaryLabel="Sign out"
        secondaryAccessibilityLabel="Sign out"
        onSecondaryPress={() => {
          void signOut();
        }}
      />
    );
  }

  if (hasConsentBootstrapError) {
    return (
      <BootstrapErrorScreen
        title="Could not load privacy choices"
        description="Check your device security settings and try again."
        primaryLabel="Retry"
        primaryAccessibilityLabel="Retry loading privacy choices"
        onPrimaryPress={() => {
          setConsentCheckError(null);
          setConsentCheckRetryKey(key => key + 1);
        }}
        secondaryLabel="Sign out"
        secondaryAccessibilityLabel="Sign out"
        onSecondaryPress={() => {
          void signOut();
        }}
      />
    );
  }

  return (
    <View
      ref={wrapperRef}
      // `opacity-0` + `pointerEvents` hide the redirecting tree visually and
      // from touch, but not from screen readers. Leave both accessibility
      // trees while hidden (iOS, then Android).
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      className={`flex-1 ${hidden ? 'opacity-0' : 'opacity-100'}`}
      pointerEvents={hidden ? 'none' : 'auto'}
    >
      <Slot />
    </View>
  );
}

function RootLayout() {
  const navigationTheme = useNavigationTheme();

  useEffect(() => {
    const subscription = setupNotificationResponseHandler();
    return () => {
      subscription.remove();
    };
  }, []);

  return (
    <ShareIntentProvider>
      <ThemeProvider value={navigationTheme}>
        <AppRootProviders>
          <StatusBar style="auto" />
          <RootLayoutNav />
          <AnimatedSplashOverlay />
        </AppRootProviders>
      </ThemeProvider>
    </ShareIntentProvider>
  );
}

export const ErrorBoundary = Sentry.wrapExpoRouterErrorBoundary(ExpoRouterErrorBoundary);

export default Sentry.wrap(RootLayout);
