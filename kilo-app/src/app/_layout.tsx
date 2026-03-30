import '../global.css';

import { PortalHost } from '@rn-primitives/portal';
import * as Sentry from '@sentry/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { isRunningInExpoGo } from 'expo';
import { Slot, useNavigationContainerRef, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Toaster } from 'sonner-native';

import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { ContextProvider, useAppContext } from '@/lib/context/context-context';
import { useForceUpdate } from '@/lib/hooks/use-force-update';
import { queryClient } from '@/lib/query-client';
import { trpcClient, TRPCProvider } from '@/lib/trpc';

const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
});

Sentry.init({
  dsn: 'https://618cf025f1c6bdea8043fcd80668fe6b@o4509356317474816.ingest.us.sentry.io/4511110711279616',

  enabled: !__DEV__,

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

function RootLayoutNav() {
  const { token, isLoading: authLoading } = useAuth();
  const { context, isLoading: contextLoading } = useAppContext();
  const { updateRequired, isChecking: updateChecking } = useForceUpdate();
  const segments = useSegments();
  const router = useRouter();

  const isLoading = authLoading || contextLoading || updateChecking;
  const inAuthGroup = segments[0] === '(auth)';
  const inContextGroup = segments[0] === '(context)';
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
    } else if (!context) {
      if (inContextGroup) {
        void SplashScreen.hideAsync();
      } else {
        router.replace('/(context)/select');
      }
    } else if (inAuthGroup || inContextGroup) {
      router.replace('/(app)');
    } else {
      void SplashScreen.hideAsync();
    }
  }, [
    token,
    context,
    isLoading,
    updateRequired,
    inAuthGroup,
    inContextGroup,
    inForceUpdate,
    router,
  ]);

  const needsForceUpdate = updateRequired && !inForceUpdate;
  const showingForceUpdate = updateRequired && inForceUpdate;
  const needsAuth = !token && !inAuthGroup;
  const needsContext = token != null && !context && !inContextGroup;
  const needsAppRedirect =
    (token != null && context != null && (inAuthGroup || inContextGroup)) || inForceUpdate;

  const needsRedirect =
    !isLoading &&
    (needsForceUpdate || (!showingForceUpdate && (needsAuth || needsContext || needsAppRedirect)));

  if (isLoading || needsRedirect) {
    return null;
  }

  return (
    <Animated.View className="flex-1" entering={FadeIn.duration(300)}>
      <Slot />
    </Animated.View>
  );
}

function RootLayout() {
  const ref = useNavigationContainerRef();

  useEffect(() => {
    if (ref.current) {
      navigationIntegration.registerNavigationContainer(ref);
    }
  }, [ref]);

  return (
    <GestureHandlerRootView className="flex-1">
      <StatusBar style="auto" />
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ContextProvider>
              <RootLayoutNav />
              <Toaster />
              <PortalHost />
            </ContextProvider>
          </AuthProvider>
        </QueryClientProvider>
      </TRPCProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
