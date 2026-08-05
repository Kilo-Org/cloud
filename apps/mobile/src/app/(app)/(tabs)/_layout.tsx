import * as Haptics from 'expo-haptics';
import { type Href, Tabs, usePathname, useRouter } from 'expo-router';
import { Bot, House, MessageSquare, UserRound } from 'lucide-react-native';
import { Platform, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BlurBar } from '@/components/ui/blur-bar';
import { Text } from '@/components/ui/text';
import { useKiloClawTabVisible } from '@/lib/hooks/use-kiloclaw-tab-visible';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getEffectiveTabBarHeight,
  getTabBarIconSize,
  shouldHideTabBar,
  shouldShowTabLabel,
  TAB_LABEL_WRAP_FONT_SCALE,
  tabAccessibilityLabel,
} from '@/lib/tab-bar-layout';

const TAB_BAR_ICON_STYLE = {
  alignItems: 'center',
  justifyContent: 'center',
} satisfies ViewStyle;
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

function TabLabel({ label, focused }: Readonly<{ label: string; focused: boolean }>) {
  return (
    <Text
      accessible={false}
      className={
        focused
          ? 'w-full text-center font-mono-medium text-[11px] leading-4 uppercase tracking-[0.2px] text-foreground'
          : 'w-full text-center font-mono-medium text-[11px] leading-4 uppercase tracking-[0.2px] text-muted-foreground'
      }
      numberOfLines={2}
    >
      {label}
    </Text>
  );
}

export default function TabsLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const hideTabs = shouldHideTabBar(pathname);
  const showTabLabel = shouldShowTabLabel(fontScale);
  const tabBarHeight = getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
  });
  const tabIconSize = getTabBarIconSize(fontScale);
  const showKiloClawTab = useKiloClawTabVisible();
  const tabCount = showKiloClawTab ? 4 : 3;

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
        tabBarStyle: {
          backgroundColor: 'transparent',
          borderTopColor: 'transparent',
          borderTopWidth: 0,
          display: hideTabs ? 'none' : 'flex',
          elevation: 0,
          height: tabBarHeight,
          position: 'absolute',
        },
        tabBarShowLabel: showTabLabel,
      }}
    >
      <Tabs.Screen
        name="(0_home)"
        options={{
          title: 'Home',
          tabBarAccessibilityLabel: tabAccessibilityLabel('Home', 1, tabCount),
          tabBarLabel: ({ focused }) => <TabLabel label="Home" focused={focused} />,
          tabBarIcon: ({ color, focused }) => (
            <House size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
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
          href: showKiloClawTab ? undefined : null,
          title: 'KiloClaw',
          tabBarAccessibilityLabel: tabAccessibilityLabel('KiloClaw', 2, tabCount),
          tabBarLabel: ({ focused }) => (
            <TabLabel
              label={fontScale > TAB_LABEL_WRAP_FONT_SCALE ? 'Kilo\nClaw' : 'KiloClaw'}
              focused={focused}
            />
          ),
          tabBarIcon: ({ color, focused }) => (
            <MessageSquare size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
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
          tabBarAccessibilityLabel: tabAccessibilityLabel(
            'Agents',
            showKiloClawTab ? 3 : 2,
            tabCount
          ),
          tabBarLabel: ({ focused }) => <TabLabel label="Agents" focused={focused} />,
          tabBarIcon: ({ color, focused }) => (
            <Bot size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
        listeners={{
          tabPress: () => {
            void Haptics.selectionAsync();
          },
        }}
      />
      <Tabs.Screen
        name="(3_profile)"
        options={{
          title: 'Profile',
          tabBarAccessibilityLabel: tabAccessibilityLabel(
            'Profile',
            showKiloClawTab ? 4 : 3,
            tabCount
          ),
          tabBarLabel: ({ focused }) => <TabLabel label="Profile" focused={focused} />,
          tabBarIcon: ({ color, focused }) => (
            <UserRound size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
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
