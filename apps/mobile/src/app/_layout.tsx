import '../global.css';
import '@/lib/cloud-agent-runtime';

import {
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
} from '@expo-google-fonts/jetbrains-mono';
import * as Sentry from '@sentry/react-native';
import { isRunningInExpoGo } from 'expo';
import { useFonts } from 'expo-font';
import {
  type Href,
  Slot,
  useGlobalSearchParams,
  useNavigationContainerRef,
  usePathname,
  useRouter,
  useSegments,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { AppRootProviders } from '@/components/app-root-providers';
import { BootstrapErrorScreen } from '@/components/bootstrap-error-screen';
import { useAuth } from '@/lib/auth/auth-context';
import { consentModeForSearchParam } from '@/components/consent/consent-mode';
import { checkConsentGate } from '@/lib/consent-gate';
import { subscribeToConsentChanges } from '@/lib/consent';
import { useAppsFlyerConsentGate } from '@/lib/hooks/use-appsflyer-consent-gate';
import { useForceUpdate } from '@/lib/hooks/use-force-update';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  checkInitialNotification,
  getPendingNotificationLink,
  setupNotificationHandler,
  setupNotificationResponseHandler,
} from '@/lib/notifications';
import { resolvePendingNotificationNavigation } from '@/lib/pending-notification-navigation';

const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
});

Sentry.init({
  dsn: 'https://618cf025f1c6bdea8043fcd80668fe6b@o4509356317474816.ingest.us.sentry.io/4511110711279616',

  enabled: true,

  sendDefaultPii: false,

  enableLogs: true,
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,
  attachScreenshot: true,
  attachViewHierarchy: true,

  integrations: [Sentry.mobileReplayIntegration(), navigationIntegration],
  enableNativeFramesTracking: false,

  spotlight: __DEV__,
});

void SplashScreen.preventAutoHideAsync();
setupNotificationHandler();
checkInitialNotification();

function RootLayoutNav() {
  const { token, isLoading: authLoading, signOut } = useAuth();
  const { updateRequired, isChecking: updateChecking } = useForceUpdate();
  const [fontsLoaded, fontsError] = useFonts({
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
  });
  const segments = useSegments();
  const pathname = usePathname();
  const { mode } = useGlobalSearchParams<{ mode?: string }>();
  const router = useRouter();
  const {
    userId,
    isLoading: userIdLoading,
    isError: userIdError,
    refetch: refetchUserId,
  } = useCurrentUserId({ enabled: token != null });
  const [consentChecked, setConsentChecked] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [consentCheckError, setConsentCheckError] = useState<unknown>(null);
  const [consentCheckRetryKey, setConsentCheckRetryKey] = useState(0);

  useEffect(() => {
    if (fontsError) {
      Sentry.captureException(fontsError);
    }
  }, [fontsError]);

  const fontsReady = fontsLoaded || fontsError !== null;
  const isLoading = authLoading || updateChecking || !fontsReady;
  const inAuthGroup = segments[0] === '(auth)';
  const inForceUpdate = segments[0] === 'force-update';
  const onConsentRoute = pathname === '/consent' || pathname === '/consent-details';
  const onConsentReviewRoute = onConsentRoute && consentModeForSearchParam(mode) === 'review';

  useEffect(() => {
    let cancelled = false;

    async function checkConsent() {
      if (!token || !userId) {
        setConsentChecked(false);
        setNeedsConsent(false);
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
        setConsentChecked(false);
        setConsentCheckError(result.error);
        return;
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
      setConsentChecked(true);
    });

    return unsubscribe;
  }, [token, userId]);

  useAppsFlyerConsentGate({ hasToken: token != null, consentChecked, needsConsent });

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (updateRequired) {
      if (!inForceUpdate) {
        router.replace('/force-update');
      } else {
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
        void SplashScreen.hideAsync();
      } else {
        router.replace('/(auth)/login');
      }
    } else {
      if (userIdError) {
        void SplashScreen.hideAsync();
        return;
      }

      if (consentCheckError) {
        void SplashScreen.hideAsync();
        return;
      }

      if (userIdLoading || !consentChecked) {
        return;
      }

      if (needsConsent) {
        if (onConsentRoute) {
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

      void SplashScreen.hideAsync();
      // Navigate to pending notification deep link (cold start / background tap)
      const pendingNavigation = resolvePendingNotificationNavigation(getPendingNotificationLink());
      if (pendingNavigation) {
        router.replace(pendingNavigation.href as Href);
      }
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
    <AppRootProviders>
      <StatusBar style="auto" />
      <RootLayoutNav />
    </AppRootProviders>
  );
}

export default Sentry.wrap(RootLayout);
