import { Stack, useNavigationContainerRef, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { UserWebConnectionProvider } from '@/components/agents/user-web-connection-provider';
import { KiloChatPresenceMount } from '@/components/kilo-chat/kilo-chat-presence-mount';
import { KiloChatProvider } from '@/components/kilo-chat/kilo-chat-provider';
import { SharePayloadNavigator } from '@/components/share/share-payload-navigator';
import { ActiveSessionsLiveSyncMount } from '@/lib/active-sessions-live-sync-mount';
import { attemptLogoutReconciliation } from '@/lib/auth/logout-reconciliation';
import {
  attemptPushRegistrationReconciliation,
  subscribeToPushTokenRotation,
} from '@/lib/auth/push-registration-reconciliation';
import { useFormSheetDetents } from '@/lib/form-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { CachePersistenceMount } from '@/lib/persist/cache-persistence-mount';

/**
 * Attempts failed logout cleanup on every "next authenticated opportunity":
 * once `user.getMe` has resolved on the authenticated mount, and on each
 * AppState return to `active` while authenticated. The attempt itself is
 * single-flight with 60 s spacing, so foreground flaps do not hammer the
 * server and a transient failure retries on the next foreground.
 */
function LogoutReconciliationMount() {
  const { userId, isLoading, isError } = useCurrentUserId();

  useEffect(() => {
    if (!userId || isLoading || isError) {
      return undefined;
    }

    void attemptLogoutReconciliation(userId);

    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void attemptLogoutReconciliation(userId);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [userId, isLoading, isError]);

  return null;
}

/**
 * Ensures the signed-in user owns the device's Expo push token on every
 * authenticated opportunity: once `user.getMe` has resolved on the
 * authenticated mount, on each AppState return to `active`, and on each push
 * token rotation. The attempt itself is single-flight with 60 s spacing, so
 * foreground flaps do not hammer the server and a transient failure retries
 * on the next foreground.
 */
function PushRegistrationMount() {
  const { userId, isLoading, isError } = useCurrentUserId();

  useEffect(() => {
    if (!userId || isLoading || isError) {
      return undefined;
    }

    void attemptPushRegistrationReconciliation(userId);

    const appState = AppState.addEventListener('change', next => {
      if (next === 'active') {
        void attemptPushRegistrationReconciliation(userId);
      }
    });
    const unsubscribeRotation = subscribeToPushTokenRotation(userId);

    return () => {
      appState.remove();
      unsubscribeRotation();
    };
  }, [userId, isLoading, isError]);

  return null;
}

/** TEMP-DEBUG: log the full navigation state and dispatch stack on every change. */
function ExitDebugMount() {
  const navigationRef = useNavigationContainerRef();
  const router = useRouter();
  useEffect(() => {
    const dump = (s: unknown): unknown => {
      if (!s || typeof s !== 'object') return s;
      const st = s as {
        index?: number;
        routes?: Array<{ name?: string; params?: unknown; state?: unknown }>;
      };
      return {
        index: st.index,
        routes: st.routes?.map(r => ({
          name: r.name,
          params: r.params,
          children: dump(r.state),
        })),
      };
    };
    const unsubscribe = navigationRef.addListener('state', () => {
      const state = navigationRef.getRootState();
      console.log('[exit-debug] state (layout):', JSON.stringify(dump(state)));
      console.log('[exit-debug] stack:', new Error().stack);
    });
    // TEMP-DEBUG: wrap router methods to capture the dispatch call site.
    const methods = ['push', 'navigate', 'replace', 'dismissTo', 'dismissAll', 'dismiss'] as const;
    const originals = methods.map(method => [method, router[method]] as const);
    for (const [method] of originals) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TEMP-DEBUG wrapper
      (router as any)[method] = (...args: any[]) => {
        console.log(`[exit-debug] router.${method}:`, JSON.stringify(args[0]), new Error().stack);
        const original = originals.find(([name]) => name === method)?.[1];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TEMP-DEBUG wrapper
        return (original as any)(...args);
      };
    }
    return () => {
      unsubscribe();
      for (const [method, original] of originals) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TEMP-DEBUG restore
        (router as any)[method] = original;
      }
    };
  }, [navigationRef, router]);
  return null;
}

export default function AppLayout() {
  const colors = useThemeColors();
  const { fullSheetDetent } = useFormSheetDetents();

  return (
    <UserWebConnectionProvider>
      <ActiveSessionsLiveSyncMount />
      <CachePersistenceMount />
      <LogoutReconciliationMount />
      <PushRegistrationMount />
      <ExitDebugMount />
      <SharePayloadNavigator />
      <KiloChatProvider>
        <KiloChatPresenceMount>
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: colors.background },
              headerShown: false,
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.foreground,
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="pr-review/index" options={{ headerShown: false }} />
            <Stack.Screen
              name="pr-review/[owner]/[repo]/[number]"
              options={{ headerShown: false }}
            />
            <Stack.Screen name="agent-chat/new" options={{ headerShown: false }} />
            <Stack.Screen name="agent-chat/[session-id]" />
            <Stack.Screen
              name="agent-chat/model-picker"
              options={{
                presentation: 'formSheet',
                sheetAllowedDetents: [0.5, fullSheetDetent],
                sheetGrabberVisible: true,
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="agent-chat/repo-picker"
              options={{
                presentation: 'formSheet',
                sheetAllowedDetents: [0.5, fullSheetDetent],
                sheetGrabberVisible: true,
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="agent-chat/mode-picker"
              options={{
                presentation: 'formSheet',
                sheetAllowedDetents: [0.5],
                sheetGrabberVisible: true,
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="agent-chat/instance-picker"
              options={{
                presentation: 'formSheet',
                sheetAllowedDetents: [0.5, fullSheetDetent],
                sheetGrabberVisible: true,
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="agent-chat/continue-picker"
              options={{
                presentation: 'formSheet',
                sheetAllowedDetents: [0.5, fullSheetDetent],
                sheetGrabberVisible: true,
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="share-gate"
              options={{
                presentation: 'formSheet',
                sheetAllowedDetents: [0.5, fullSheetDetent],
                sheetGrabberVisible: true,
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="kilo-pass"
              options={{
                presentation: 'modal',
                headerShown: false,
              }}
            />
            <Stack.Screen
              name="onboarding"
              options={{
                presentation: 'modal',
                headerShown: false,
                gestureEnabled: false,
              }}
            />
            <Stack.Screen
              name="consent"
              options={{
                presentation: 'modal',
                headerShown: false,
                gestureEnabled: false,
              }}
            />
            <Stack.Screen
              name="consent-details"
              options={{
                headerShown: false,
              }}
            />
          </Stack>
        </KiloChatPresenceMount>
      </KiloChatProvider>
    </UserWebConnectionProvider>
  );
}
