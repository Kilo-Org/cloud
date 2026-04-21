import * as Haptics from 'expo-haptics';
import { type Href, Tabs, useRouter } from 'expo-router';
import { Bot, House, MessageSquare } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { getLastActiveInstance, loadLastActiveInstance } from '@/lib/last-active-instance';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const ANDROID_TAB_BAR_EXTRA_PADDING = 4;

export const unstable_settings = {
  initialRouteName: '(0_home)',
};

export default function TabsLayout() {
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const router = useRouter();
  const { data: instances } = useAllKiloClawInstances();
  const [lastActiveHydrated, setLastActiveHydrated] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        await loadLastActiveInstance();
      } finally {
        setLastActiveHydrated(true);
      }
    })();
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        freezeOnBlur: true,
        tabBarActiveTintColor: colors.foreground,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
          ...(Platform.OS === 'android' && {
            height: 50 + bottom + ANDROID_TAB_BAR_EXTRA_PADDING,
          }),
        },
      }}
    >
      <Tabs.Screen
        name="(0_home)"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <House size={size} color={color} />,
        }}
        listeners={{
          tabPress: () => {
            void Haptics.selectionAsync();
          },
        }}
      />
      <Tabs.Screen
        name="(1_kiloclaw)"
        options={{
          title: 'KiloClaw',
          tabBarIcon: ({ color, size }) => <MessageSquare size={size} color={color} />,
        }}
        listeners={{
          tabPress: e => {
            void Haptics.selectionAsync();
            // While instances or the persisted last-active id are still loading,
            // block the tab switch so the user doesn't briefly land on the
            // (1_kiloclaw) empty state, and so we don't redirect into the wrong
            // chat before the persisted instance has been hydrated.
            if (instances === undefined || !lastActiveHydrated) {
              e.preventDefault();
              return;
            }
            const first = instances[0];
            if (first) {
              e.preventDefault();
              const lastId = getLastActiveInstance();
              const target =
                lastId && instances.some(i => i.sandboxId === lastId) ? lastId : first.sandboxId;
              router.push(`/(app)/chat/${target}` as Href);
            }
          },
        }}
      />
      <Tabs.Screen
        name="(2_agents)"
        options={{
          title: 'Agents',
          tabBarIcon: ({ color, size }) => <Bot size={size} color={color} />,
        }}
        listeners={{
          tabPress: () => {
            void Haptics.selectionAsync();
          },
        }}
      />
    </Tabs>
  );
}
