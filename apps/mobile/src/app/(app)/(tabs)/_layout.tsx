import * as Haptics from 'expo-haptics';
import { type Href, Tabs, useRouter } from 'expo-router';
import { Bot, House, MessageSquare } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, type TextStyle, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BlurBar } from '@/components/ui/blur-bar';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getLastActiveInstance, loadLastActiveInstance } from '@/lib/last-active-instance';

const ANDROID_TAB_BAR_EXTRA_PADDING = 4;
const TAB_BAR_ITEM_CONTENT_WIDTH = 64;
const TAB_BAR_ICON_STYLE = {
  alignItems: 'center',
  justifyContent: 'center',
  width: TAB_BAR_ITEM_CONTENT_WIDTH,
} satisfies ViewStyle;
const TAB_BAR_LABEL_STYLE = {
  fontFamily: 'JetBrainsMono_500Medium',
  fontSize: 10,
  letterSpacing: 0,
  marginTop: 2,
  minWidth: TAB_BAR_ITEM_CONTENT_WIDTH,
  textAlign: 'center',
  textTransform: 'uppercase',
} satisfies TextStyle;

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
        tabBarIconStyle: TAB_BAR_ICON_STYLE,
        tabBarLabelPosition: 'below-icon',
        tabBarLabelStyle: TAB_BAR_LABEL_STYLE,
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
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <House size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
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
          tabBarLabel: 'KiloClaw',
          tabBarIcon: ({ color, focused }) => (
            <MessageSquare size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
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
          tabBarLabel: 'Agents',
          tabBarIcon: ({ color, focused }) => (
            <Bot size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
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
