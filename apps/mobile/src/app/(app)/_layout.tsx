import { Stack } from 'expo-router';

import { UserWebConnectionProvider } from '@/components/agents/user-web-connection-provider';
import { KiloChatPresenceMount } from '@/components/kilo-chat/kilo-chat-presence-mount';
import { KiloChatProvider } from '@/components/kilo-chat/kilo-chat-provider';
import { ActiveSessionsLiveSyncMount } from '@/lib/active-sessions-live-sync-mount';
import { useFormSheetDetents } from '@/lib/form-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { StoreKiloPassPurchaseProvider } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';

export default function AppLayout() {
  const colors = useThemeColors();
  const { fullSheetDetent } = useFormSheetDetents();

  return (
    <UserWebConnectionProvider>
      <ActiveSessionsLiveSyncMount />
      <KiloChatProvider>
        <KiloChatPresenceMount>
          <StoreKiloPassPurchaseProvider>
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
          </StoreKiloPassPurchaseProvider>
        </KiloChatPresenceMount>
      </KiloChatProvider>
    </UserWebConnectionProvider>
  );
}
