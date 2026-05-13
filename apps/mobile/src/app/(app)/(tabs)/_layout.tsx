import * as Haptics from 'expo-haptics';
import { type Href, Tabs, usePathname, useRouter } from 'expo-router';
import { Bot, House, MessageSquare } from 'lucide-react-native';
import { Platform, type TextStyle, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BlurBar } from '@/components/ui/blur-bar';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { ANDROID_TAB_BAR_EXTRA_PADDING, TAB_BAR_BASE_HEIGHT } from '@/lib/tab-bar-layout';

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
  const router = useRouter();
  const pathname = usePathname();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const pathParts = pathname.split('/').filter(Boolean);
  const hideTabs =
    pathParts[0] === 'chat' && pathParts.length === 3 && pathParts[2] !== 'rename-conversation';

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
          display: hideTabs ? 'none' : 'flex',
          elevation: 0,
          position: 'absolute',
          ...(Platform.OS === 'android' && {
            height: TAB_BAR_BASE_HEIGHT + bottom + ANDROID_TAB_BAR_EXTRA_PADDING,
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
          tabPress: event => {
            void Haptics.selectionAsync();
            event.preventDefault();
            router.navigate('/(app)/(tabs)/(1_kiloclaw)' as Href);
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
