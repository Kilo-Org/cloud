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
import { useFonts } from 'expo-font';
import {
  type Href,
  Slot,
  ThemeProvider,
  useGlobalSearchParams,
  useNavigationContainerRef,
  usePathname,
  useRouter,
  useSegments,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { AppRootProviders } from '@/components/app-root-providers';
import { BootstrapErrorScreen } from '@/components/bootstrap-error-screen';
import { useAuth } from '@/lib/auth/auth-context';
import { consentModeForSearchParam } from '@/components/consent/consent-mode';
import { checkConsentGate } from '@/lib/consent-gate';
import { subscribeToConsentChanges } from '@/lib/consent';
import { shouldStartAnalytics } from '@/lib/analytics-consent';
import { APP_STARTUP_EVENT, captureEvent } from '@/lib/analytics/posthog';
import { markStartup, markStartupComplete, takeStartupTimings } from '@/lib/startup-timing';
import { useAnalyticsConsentGate } from '@/lib/hooks/use-analytics-consent-gate';
import { useForceUpdate } from '@/lib/hooks/use-force-update';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useScreenTracking } from '@/lib/hooks/use-screen-tracking';
import { useNavigationTheme } from '@/lib/hooks/use-theme-colors';
import { applyThemePreference, useThemePreference } from '@/lib/hooks/use-theme-preference';
import { useTrackingPermissionPrompt } from '@/lib/hooks/use-tracking-permission-prompt';
import { captureLaunchDeepLink, getPendingDeepLink } from '@/lib/deep-link-launch';
import {
  checkInitialNotification,
  setupNotificationHandler,
  setupNotificationResponseHandler,
} from '@/lib/notifications';
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
import { sentryOptionsForConsent } from '@/lib/sentry-consent';
import { resolveSentryEnvironment } from '@/lib/sentry-environment';
import { useSentryConsentSync } from '@/lib/hooks/use-sentry-consent-sync';

const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
});

// No-op unless E2E_LATENCY_WS_MS is set at bundle time (see lib/e2e-ws-latency).
installE2EWebSocketLatency();

// DEC-02 consent rule: crash and error reporting is mandatory, so
// `initSentry(false)` runs at module scope — a crash during bootstrap
// must still be reported. The optional group is `tracesSampleRate`
// only. Account identity is cleared by step 7's `Sentry.setUser(null)`.
//
// In-scope core-loop spans (tracesSampleRate > 0 when optional consent is true):
// — `app.start.cold` / `app.start.warm` (TTID / TTFD via React Navigation
//   integration). The authoritative per-launch timing metric is the PostHog
//   `app_startup` event in src/lib/startup-timing.ts.
function initSentry(optionalConsented: boolean) {
  Sentry.init({
    dsn: 'https://618cf025f1c6bdea8043fcd80668fe6b@o4509356317474816.ingest.us.sentry.io/4511110711279616',

    enabled: true,

    sendDefaultPii: false,

    environment: resolveSentryEnvironment(SENTRY_ENVIRONMENT, __DEV__),
    ...sentryOptionsForConsent(optionalConsented),

    integrations: [navigationIntegration],
    enableNativeFramesTracking: false,

    spotlight: __DEV__,
  });
}

initSentry(false);

void SplashScreen.preventAutoHideAsync();
setupNotificationHandler();
checkInitialNotification();
captureLaunchDeepLink();

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

  useEffect(() => {
    if (fontsError) {
      Sentry.captureException(fontsError);
    }
  }, [fontsError]);

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

  useTrackingPermissionPrompt(!isLoading);
  useAnalyticsConsentGate({
    hasToken: token != null,
    consentChecked,
    needsConsent,
    email,
    accountId: userId,
    optionalConsent,
  });
  useScreenTracking();

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
        void SplashScreen.hideAsync();
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
        void SplashScreen.hideAsync();
      } else {
        router.replace('/(auth)/login');
      }
    } else {
      if (userIdError) {
        markStartupComplete('user-error');
        setStartupFinished(true);
        void SplashScreen.hideAsync();
        return;
      }

      if (consentCheckError) {
        markStartupComplete('consent-error');
        setStartupFinished(true);
        void SplashScreen.hideAsync();
        return;
      }

      if (userIdLoading || !consentChecked) {
        return;
      }

      if (needsConsent) {
        if (onConsentRoute) {
          markStartupComplete('consent');
          setStartupFinished(true);
          void SplashScreen.hideAsync();
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
      void SplashScreen.hideAsync();
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

  // One `app_startup` event per launch. It needs BOTH "startup finished" and
  // "analytics is allowed to run", and neither implies the other — a
  // consent-settled launch can still be waiting on fonts, and a splash hidden
  // at the consent screen has no analytics client yet. So both are
  // dependencies, and whichever settles last triggers the send.
  //
  // Must stay the LAST effect here: `takeStartupTimings()` consumes the payload
  // and `captureEvent` no-ops while the PostHog client is null, so this has to
  // run after useAnalyticsConsentGate's initPostHog().
  //
  // Signed-out launches are never reported — PostHog does not start without
  // consent, and that is the intended trade.
  useEffect(() => {
    if (
      !startupFinished ||
      !shouldStartAnalytics({ hasToken: token != null, consentChecked, needsConsent })
    ) {
      return;
    }
    const timings = takeStartupTimings();
    if (timings) {
      captureEvent(APP_STARTUP_EVENT, timings);
    }
  }, [startupFinished, token, consentChecked, needsConsent]);

  const needsForceUpdate = updateRequired && !inForceUpdate;
  const showingForceUpdate = updateRequired && inForceUpdate;
  const needsAuth = !token && !inAuthGroup;
  const needsAppRedirect = token != null && inAuthGroup;
  const hasUserBootstrapError = token != null && userIdError;
  const hasConsentBootstrapError = token != null && consentCheckError !== null;
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
      className={`flex-1 ${hidden ? 'opacity-0' : 'opacity-100'}`}
      pointerEvents={hidden ? 'none' : 'auto'}
    >
      <Slot />
    </View>
  );
}

function RootLayout() {
  const ref = useNavigationContainerRef();
  const navigationTheme = useNavigationTheme();

  useEffect(() => {
    if (ref.current) {
      navigationIntegration.registerNavigationContainer(ref);
    }
  }, [ref]);

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
        </AppRootProviders>
      </ThemeProvider>
    </ShareIntentProvider>
  );
}

export default Sentry.wrap(RootLayout);
