import '../global.css';

import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { PortalHost } from '@rn-primitives/portal';
import * as Sentry from '@sentry/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { isRunningInExpoGo } from 'expo';
import { type Href, Slot, useNavigationContainerRef, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { requestTrackingPermissionsAsync } from 'expo-tracking-transparency';
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Toaster } from 'sonner-native';

import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { initAppsFlyer } from '@/lib/appsflyer';
import {
  checkInitialNotification,
  getPendingNotificationLink,
  setupNotificationHandler,
  setupNotificationResponseHandler,
} from '@/lib/notifications';
import { useForceUpdate } from '@/lib/hooks/use-force-update';
import { queryClient } from '@/lib/query-client';
import { trpcClient, TRPCProvider } from '@/lib/trpc';

const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
});

Sentry.init({
  dsn: 'https://618cf025f1c6bdea8043fcd80668fe6b@o4509356317474816.ingest.us.sentry.io/4511110711279616',

  enabled: true,

  sendDefaultPii: false,

  // Enable Logs
  enableLogs: true,

  tracesSampleRate: 1,

  // Configure Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,

  // Capture a screenshot and view hierarchy on every error
  attachScreenshot: true,
  attachViewHierarchy: true,

  integrations: [Sentry.mobileReplayIntegration(), navigationIntegration],
  enableNativeFramesTracking: !isRunningInExpoGo(),

  // uncomment the line below to enable Spotlight (https://spotlightjs.com)
  spotlight: __DEV__,
});

void SplashScreen.preventAutoHideAsync();
setupNotificationHandler();
checkInitialNotification();

function RootLayoutNav() {
  const { token, isLoading: authLoading } = useAuth();
  const { updateRequired, isChecking: updateChecking } = useForceUpdate();
  const segments = useSegments();
  const router = useRouter();

  const isLoading = authLoading || updateChecking;
  const inAuthGroup = segments[0] === '(auth)';
  const inForceUpdate = segments[0] === 'force-update';

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
      // Version is now acceptable, leave the force-update screen
      router.replace('/(app)');
      return;
    }

    if (!token) {
      if (inAuthGroup) {
        void SplashScreen.hideAsync();
      } else {
        router.replace('/(auth)/login');
      }
    } else if (inAuthGroup) {
      router.replace('/(app)');
    } else {
      void SplashScreen.hideAsync();
      // Navigate to pending notification deep link (cold start / background tap)
      const pendingLink = getPendingNotificationLink();
      if (pendingLink) {
        router.push(pendingLink as Href);
      }
    }
  }, [token, isLoading, updateRequired, inAuthGroup, inForceUpdate, router]);

  const needsForceUpdate = updateRequired && !inForceUpdate;
  const showingForceUpdate = updateRequired && inForceUpdate;
  const needsAuth = !token && !inAuthGroup;
  const needsAppRedirect = token != null && inAuthGroup;

  const needsRedirect =
    !isLoading && (needsForceUpdate || (!showingForceUpdate && (needsAuth || needsAppRedirect)));

  // Always keep Slot mounted so Expo Router's navigation tree stays
  // initialised — returning null unmounts it and breaks router.replace.
  // The native splash screen covers everything during initial load, and
  // opacity 0 hides the wrong screen during redirects.
  const hidden = isLoading || needsRedirect;

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
    async function startAppsFlyer() {
      if (Platform.OS === 'ios') {
        await requestTrackingPermissionsAsync();
      }
      initAppsFlyer();
    }
    void startAppsFlyer();
  }, []);

  useEffect(() => {
    const subscription = setupNotificationResponseHandler();
    return () => {
      subscription.remove();
    };
  }, []);

  return (
    <GestureHandlerRootView className="flex-1">
      <StatusBar style="auto" />
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ActionSheetProvider>
              <>
                <RootLayoutNav />
                <Toaster />
                <PortalHost />
              </>
            </ActionSheetProvider>
          </AuthProvider>
        </QueryClientProvider>
      </TRPCProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
