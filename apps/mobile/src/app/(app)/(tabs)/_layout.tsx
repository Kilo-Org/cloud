import * as Haptics from 'expo-haptics';
import { Tabs } from 'expo-router';
import { Bot, MessageSquare } from 'lucide-react-native';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const ANDROID_TAB_BAR_EXTRA_PADDING = 4;

export default function TabsLayout() {
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();

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
        name="(1_kiloclaw)"
        options={{
          title: 'KiloClaw',
          tabBarIcon: ({ color, size }) => <MessageSquare size={size} color={color} />,
        }}
        listeners={{
          tabPress: () => {
            void Haptics.selectionAsync();
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
