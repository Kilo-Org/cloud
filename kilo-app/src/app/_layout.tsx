import '../global.css';

import { PortalHost } from '@rn-primitives/portal';
import * as Sentry from '@sentry/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { isRunningInExpoGo } from 'expo';
import { Slot, useNavigationContainerRef, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Toaster } from 'sonner-native';

import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { ForceUpgradeScreen } from '@/components/force-upgrade-screen';
import { ContextProvider, useAppContext } from '@/lib/context/context-context';
import { useForceUpgrade } from '@/lib/hooks/use-force-upgrade';
import { useOTAUpdates } from '@/lib/hooks/use-ota-updates';
import { queryClient } from '@/lib/query-client';
import { trpcClient, TRPCProvider } from '@/lib/trpc';

const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
});

Sentry.init({
  dsn: 'https://618cf025f1c6bdea8043fcd80668fe6b@o4509356317474816.ingest.us.sentry.io/4511110711279616',

  enabled: !__DEV__,

  // Adds more context data to events (IP address, cookies, user, etc.)
  // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
  sendDefaultPii: true,

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
  const segments = useSegments();
  const router = useRouter();
  const { blocked, otaForceUpdate, isChecking: upgradeChecking } = useForceUpgrade();
  const { isBlocking: otaBlocking } = useOTAUpdates(!blocked && otaForceUpdate);

  const isLoading = authLoading || contextLoading || upgradeChecking || otaBlocking;
  const inAuthGroup = segments[0] === '(auth)';
  const inContextGroup = segments[0] === '(context)';

  useEffect(() => {
    if (isLoading || blocked) {
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
  }, [token, context, isLoading, blocked, inAuthGroup, inContextGroup, router]);

  const needsRedirect =
    !isLoading &&
    ((!token && !inAuthGroup) ||
      (token != null && !context && !inContextGroup) ||
      (token != null && context != null && (inAuthGroup || inContextGroup)));

  if (isLoading) {
    return null;
  }

  if (blocked) {
    return <ForceUpgradeScreen />;
  }

  if (needsRedirect) {
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
