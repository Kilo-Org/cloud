import * as Haptics from 'expo-haptics';
import { type Href, Tabs, useRouter } from 'expo-router';
import { Bot, House, MessageSquare } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BlurBar } from '@/components/ui/blur-bar';
import { Text } from '@/components/ui/text';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getLastActiveInstance, loadLastActiveInstance } from '@/lib/last-active-instance';

const ANDROID_TAB_BAR_EXTRA_PADDING = 4;

export const unstable_settings = {
  initialRouteName: '(0_home)',
};

function TabBarBackground() {
  return (
    <BlurBar className="absolute inset-0">
      <View className="flex-1" />
    </BlurBar>
  );
}

function renderTabBarLabel(label: string) {
  // Mirrors the "eyebrow" variant (mono/uppercase/10px/muted) without the
  // letter-spacing, which would otherwise push the visible glyphs off-center
  // beneath the icon since iOS and Android disagree on whether trailing
  // letter-spacing is included in the measured text width.
  return (
    <Text className="mt-0.5 font-mono-medium text-[10px] uppercase text-muted-foreground">
      {label}
    </Text>
  );
}

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
        tabBarBackground: TabBarBackground,
        tabBarStyle: {
          backgroundColor: 'transparent',
          borderTopColor: 'transparent',
          borderTopWidth: 0,
          elevation: 0,
          position: 'absolute',
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
          tabBarIcon: ({ color, focused }) => (
            <House size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
          tabBarLabel: () => renderTabBarLabel('Home'),
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
          tabBarIcon: ({ color, focused }) => (
            <MessageSquare size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
          tabBarLabel: () => renderTabBarLabel('KiloClaw'),
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
          tabBarIcon: ({ color, focused }) => (
            <Bot size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
          tabBarLabel: () => renderTabBarLabel('Agents'),
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
