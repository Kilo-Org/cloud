import * as Haptics from 'expo-haptics';
import { type Href, Tabs, usePathname, useRouter, useSegments } from 'expo-router';
import { Bot, House, MessageCircle, MessageSquare, UserRound } from '@/components/ui/icons';
import { useEffect } from 'react';
import { Platform, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { BlurBar } from '@/components/ui/blur-bar';
import { Text } from '@/components/ui/text';
import { FEATURE_FLAG_QUICK_CHAT, useFeatureFlag } from '@/lib/analytics/posthog';
import { PROFILE_TAB_ROOT } from '@/lib/finding-detail-back';
import { useKiloClawTabVisible } from '@/lib/hooks/use-kiloclaw-tab-visible';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getEffectiveTabBarHeight,
  getTabBarIconSize,
  shouldHideTabBar,
  shouldShowTabLabel,
  TAB_LABEL_WRAP_FONT_SCALE,
  tabAccessibilityLabel,
  tabBarPosition,
  visibleTabCount,
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
  const segments = useSegments();
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
  const showQuickChatTab = useFeatureFlag(FEATURE_FLAG_QUICK_CHAT, false);
  const tabFlags = { showKiloClaw: showKiloClawTab, showQuickChat: showQuickChatTab };
  const tabCount = visibleTabCount(showKiloClawTab, showQuickChatTab);
  const { t } = useTranslation();

  // If the flag flips off while the Chat tab is focused, its `href` becomes
  // null but the route is still mounted — move to Home instead.
  const onChatTab = segments.some(segment => segment === '(4_chat)');
  useEffect(() => {
    if (!showQuickChatTab && onChatTab) {
      router.replace('/(app)/(tabs)/(0_home)' as Href);
    }
  }, [showQuickChatTab, onChatTab, router]);

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
          title: t('tabs.home'),
          tabBarAccessibilityLabel: tabAccessibilityLabel(
            t('tabs.home'),
            tabBarPosition('home', tabFlags) ?? 1,
            tabCount
          ),
          tabBarLabel: ({ focused }) => <TabLabel label={t('tabs.home')} focused={focused} />,
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
          title: t('tabs.kiloclaw'),
          tabBarAccessibilityLabel: tabAccessibilityLabel(
            t('tabs.kiloclaw'),
            tabBarPosition('kiloclaw', tabFlags) ?? 2,
            tabCount
          ),
          tabBarLabel: ({ focused }) => (
            <TabLabel
              label={
                fontScale > TAB_LABEL_WRAP_FONT_SCALE
                  ? t('tabs.kiloclawWrapped')
                  : t('tabs.kiloclaw')
              }
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
          title: t('tabs.agents'),
          tabBarAccessibilityLabel: tabAccessibilityLabel(
            t('tabs.agents'),
            tabBarPosition('agents', tabFlags) ?? 2,
            tabCount
          ),
          tabBarLabel: ({ focused }) => <TabLabel label={t('tabs.agents')} focused={focused} />,
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
        name="(4_chat)"
        options={{
          href: showQuickChatTab ? undefined : null,
          title: t('tabs.chat'),
          tabBarAccessibilityLabel: tabAccessibilityLabel(
            t('tabs.chat'),
            tabBarPosition('chat', tabFlags) ?? 3,
            tabCount
          ),
          tabBarLabel: ({ focused }) => <TabLabel label={t('tabs.chat')} focused={focused} />,
          tabBarIcon: ({ color, focused }) => (
            <MessageCircle size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
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
          title: t('tabs.profile'),
          tabBarAccessibilityLabel: tabAccessibilityLabel(t('tabs.profile'), tabCount, tabCount),
          tabBarLabel: ({ focused }) => <TabLabel label={t('tabs.profile')} focused={focused} />,
          tabBarIcon: ({ color, focused }) => (
            <UserRound size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
        listeners={{
          tabPress: event => {
            void Haptics.selectionAsync();
            event.preventDefault();
            router.navigate(PROFILE_TAB_ROOT);
          },
        }}
      />
    </Tabs>
  );
}
