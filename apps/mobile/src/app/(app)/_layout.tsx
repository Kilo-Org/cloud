import { Stack } from 'expo-router';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';
import { useEffect, useRef } from 'react';

import { UserWebConnectionProvider } from '@/components/agents/user-web-connection-provider';
import { KiloChatPresenceMount } from '@/components/kilo-chat/kilo-chat-presence-mount';
import { KiloChatProvider } from '@/components/kilo-chat/kilo-chat-provider';
import { LauncherSurfacesMount } from '@/components/launcher-surfaces-mount';
import { SharePayloadNavigator } from '@/components/share/share-payload-navigator';
import { TourAutoOpen } from '@/components/tour/tour-auto-open';
import { ActiveSessionsLiveSyncMount } from '@/lib/active-sessions-live-sync-mount';
import { ArtifactMirrorSyncMount } from '@/lib/artifacts/artifact-mirror-sync-mount';
import { attemptLogoutReconciliation } from '@/lib/auth/logout-reconciliation';
import { GlanceablePublisherMount } from '@/lib/glanceable/mount';
import { useGlanceableOrgFence } from '@/lib/glanceable/org-fence';
import {
  attemptPushRegistrationReconciliation,
  subscribeToPushTokenRotation,
} from '@/lib/auth/push-registration-reconciliation';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useSecurityLifecycleInvalidation } from '@/lib/hooks/use-security-lifecycle-invalidation';
import { CachePersistenceMount } from '@/lib/persist/cache-persistence-mount';
import { SystemSearchIndexMount } from '@/lib/system-search-index-mount';
import { ToolSummaryTranslationRetryMount } from '@/lib/tool-summary-translation/tool-summary-translation-retry-mount';
import { useTRPC } from '@/lib/trpc';

/**
 * The single owner of the app's authenticated foreground reconciliation work,
 * replacing the two independent `AppState` listeners the logout and push
 * mounts used to register. Every pass runs the same ordered queue: failed
 * logout cleanup first, then push-token ownership.
 *
 * It fires on the same triggers as before — once `user.getMe` has resolved on
 * the authenticated mount (plus the push-token rotation subscription), and on
 * each return to the foreground — but the foreground path is the app's shared
 * `useAppLifecycle()` store, so the whole tree keeps one `AppState` listener
 * and the pair runs only on the background -> active edge. The store seeds
 * `isActive` as `true`, so a mount while already active is not an edge and
 * only the mount attempt runs.
 *
 * No minimum interval is added at this layer: both attempts are already
 * single-flight with 60 s spacing, and
 * `attemptPushRegistrationReconciliation` additionally skips when the stored
 * token, locale and app version already match the device
 * (`src/lib/auth/push-registration-reconciliation.ts`). Re-gating them here
 * would duplicate that contract without adding a skip.
 */
function ForegroundReconciliationMount() {
  const { userId, isLoading, isError } = useCurrentUserId();
  const { isActive } = useAppLifecycle();
  const wasActiveRef = useRef(isActive);

  // Mount attempt and push-token rotation subscription.
  useEffect(() => {
    if (!userId || isLoading || isError) {
      return undefined;
    }

    void attemptLogoutReconciliation(userId);
    void attemptPushRegistrationReconciliation(userId);
    const unsubscribeRotation = subscribeToPushTokenRotation(userId);

    return () => {
      unsubscribeRotation();
    };
  }, [userId, isLoading, isError]);

  // Foreground regain: the false -> true edge only, so an active -> active
  // echo (or a duplicate `active` from the OS) never re-runs the pair.
  useEffect(() => {
    if (!wasActiveRef.current && isActive && userId && !isLoading && !isError) {
      void attemptLogoutReconciliation(userId);
      void attemptPushRegistrationReconciliation(userId);
    }
    wasActiveRef.current = isActive;
  }, [isActive, userId, isLoading, isError]);

  return null;
}

/**
 * Refreshes app-wide freshness on foreground regain: the signed-in user,
 * their organizations, and kilo-chat conversations. The root `(app)` layout
 * is always focused, so the hook's focus gate never blocks this mount.
 */
function AppWideFreshnessMount() {
  const trpc = useTRPC();
  useRouteForegroundRefresh([
    trpc.user.getMe.queryKey(),
    trpc.organizations.list.queryKey(),
    // Kilo-chat keys are FLAT (['kilo-chat', 'conversations', …]), so the
    // partial key is the flat ['kilo-chat']; the nested tRPC form
    // [['kilo-chat']] does not prefix-match flat keys.
    ['kilo-chat'],
  ]);
  return null;
}

export default function AppLayout() {
  const colors = useThemeColors();
  const sheetOptions = useFormSheetScreenOptions();
  useSecurityLifecycleInvalidation();
  useGlanceableOrgFence();

  return (
    <UserWebConnectionProvider>
      <ActiveSessionsLiveSyncMount />
      <ArtifactMirrorSyncMount />
      <SystemSearchIndexMount />
      <GlanceablePublisherMount />
      <LauncherSurfacesMount />
      <CachePersistenceMount />
      <ToolSummaryTranslationRetryMount />
      <ForegroundReconciliationMount />
      <AppWideFreshnessMount />
      <SharePayloadNavigator />
      <TourAutoOpen />
      <KiloChatProvider>
        <KiloChatPresenceMount>
          <Stack
            screenLayout={appUnlockScreenLayout}
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
            <Stack.Screen name="agent-chat/model-picker" options={sheetOptions} />
            <Stack.Screen name="agent-chat/repo-picker" options={sheetOptions} />
            <Stack.Screen name="agent-chat/branch-picker" options={sheetOptions} />
            <Stack.Screen
              name="agent-chat/mode-picker"
              options={{ ...sheetOptions, sheetAllowedDetents: [0.5] }}
            />
            <Stack.Screen name="agent-chat/instance-picker" options={sheetOptions} />
            <Stack.Screen name="agent-chat/folder-picker" options={sheetOptions} />
            <Stack.Screen name="share-gate" options={sheetOptions} />
            <Stack.Screen name="language-picker" options={sheetOptions} />
            <Stack.Screen name="transcription-model-picker" options={sheetOptions} />
            <Stack.Screen name="voice-language-picker" options={sheetOptions} />
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
              name="tour"
              options={{
                presentation: 'modal',
                headerShown: false,
                // A swipe-down dismissal would bypass the tour's own dismissal
                // (which records the per-account decision). Match `onboarding`
                // and `consent`: the only exits are the tour's own controls and
                // Android hardware Back, both of which record first.
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
