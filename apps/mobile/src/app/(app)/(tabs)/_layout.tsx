import * as Haptics from 'expo-haptics';
import { type Href, Tabs, usePathname, useRouter, useSegments } from 'expo-router';
import { Bot, House, MessageCircle, MessageSquare, UserRound } from '@/components/ui/icons';
import { useEffect } from 'react';
import { Platform, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { BlurBar } from '@/components/ui/blur-bar';
import { Text } from '@/components/ui/text';
import { FEATURE_FLAG_CHAT, useFeatureFlag } from '@/lib/analytics/posthog';
import { PROFILE_TAB_ROOT } from '@/lib/finding-detail-back';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useKiloClawTabVisible } from '@/lib/hooks/use-kiloclaw-tab-visible';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
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
  const hideTabs = shouldHideTabBar(pathname, segments);
  const showTabLabel = shouldShowTabLabel(fontScale);
  const tabBarHeight = getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
  });
  const tabIconSize = getTabBarIconSize(fontScale);
  const showKiloClawTab = useKiloClawTabVisible();
  const showChatTab = useFeatureFlag(FEATURE_FLAG_CHAT, false);
  const tabFlags = { showKiloClaw: showKiloClawTab, showChat: showChatTab };
  const tabCount = visibleTabCount(showKiloClawTab, showChatTab);
  const { t } = useTranslation();
  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  const { activeSessions, isLoading, isError } = useLiveAgentSessions({
    organizationId,
    enabled: orgLoaded,
  });
  const attentionRevision = useSessionAttentionRevision();
  useEffect(() => {
    if (!orgLoaded) {
      return;
    }
    for (const session of activeSessions) {
      reconcileSessionAttention(session.id, session.status, null);
    }
  }, [activeSessions, orgLoaded, attentionRevision]);
  const needsInputCount = activeSessions.filter(session =>
    shouldShowNeedsInput({
      status: session.status,
      raiseId: session.status,
      isAcked: isAttentionAcked(session.id, session.status),
    })
  ).length;
  const needsInputBadge =
    orgLoaded && !isLoading && !isError && needsInputCount > 0 ? needsInputCount : undefined;

  // If the flag flips off while the Chat tab is focused, its `href` becomes
  // null but the route is still mounted, so move to Home instead.
  const onChatTab = segments.some(segment => segment === '(4_chat)');
  useEffect(() => {
    if (!showChatTab && onChatTab) {
      router.replace('/(app)/(tabs)/(0_home)' as Href);
    }
  }, [showChatTab, onChatTab, router]);

  return (
    <StateSurfaceInsets bottomInset={hideTabs ? 0 : tabBarHeight + 16}>
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
            title: t('common.kiloclaw'),
            tabBarAccessibilityLabel: tabAccessibilityLabel(
              t('common.kiloclaw'),
              tabBarPosition('kiloclaw', tabFlags) ?? 2,
              tabCount
            ),
            tabBarLabel: ({ focused }) => (
              <TabLabel
                label={
                  fontScale > TAB_LABEL_WRAP_FONT_SCALE
                    ? t('tabs.kiloclawWrapped')
                    : t('common.kiloclaw')
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
            title: t('common.agents'),
            tabBarBadge: needsInputBadge,
            tabBarAccessibilityLabel: tabAccessibilityLabel(
              needsInputBadge
                ? `${t('common.agents')}, ${needsInputBadge} ${t('agents.sessionRow.needsInput')}`
                : t('common.agents'),
              tabBarPosition('agents', tabFlags) ?? 2,
              tabCount
            ),
            tabBarLabel: ({ focused }) => <TabLabel label={t('common.agents')} focused={focused} />,
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
            href: showChatTab ? undefined : null,
            title: t('common.chat'),
            tabBarAccessibilityLabel: tabAccessibilityLabel(
              t('common.chat'),
              tabBarPosition('chat', tabFlags) ?? 3,
              tabCount
            ),
            tabBarLabel: ({ focused }) => <TabLabel label={t('common.chat')} focused={focused} />,
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
            title: t('common.profile'),
            tabBarAccessibilityLabel: tabAccessibilityLabel(
              t('common.profile'),
              tabCount,
              tabCount
            ),
            tabBarLabel: ({ focused }) => (
              <TabLabel label={t('common.profile')} focused={focused} />
            ),
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
    </StateSurfaceInsets>
  );
}
