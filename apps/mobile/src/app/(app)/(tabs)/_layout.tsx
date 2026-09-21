import * as Haptics from 'expo-haptics';
import { type Href, Tabs, usePathname, useRouter, useSegments } from 'expo-router';
import { Bot, House, MessageCircle, MessageSquare, UserRound } from '@/components/ui/icons';
import { useEffect } from 'react';
import { Platform, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { TabBarLabel } from '@/components/tab-bar-label';
import { BlurBar } from '@/components/ui/blur-bar';
import { FEATURE_FLAG_QUICK_CHAT, useFeatureFlag } from '@/lib/analytics/posthog';
import { usePendingAppAction } from '@/lib/app-actions/use-pending-app-action';
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
  getTabBarHorizontalInset,
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

/** The plain tab press: the same feedback for every tab without its own move. */
const TAB_PRESS_HAPTICS = { tabPress: () => void Haptics.selectionAsync() };

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
  const segments = useSegments();
  const colors = useThemeColors();
  const { bottom, left, right } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const hideTabs = shouldHideTabBar(pathname);
  const showTabLabel = shouldShowTabLabel(fontScale);
  const tabBarHeight = getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
  });
  const tabBarHorizontalInset = getTabBarHorizontalInset({ left, right });
  const tabIconSize = getTabBarIconSize(fontScale);
  const showKiloClawTab = useKiloClawTabVisible();
  const showQuickChatTab = useFeatureFlag(FEATURE_FLAG_QUICK_CHAT, false);
  const tabFlags = { showKiloClaw: showKiloClawTab, showQuickChat: showQuickChatTab };
  const tabCount = visibleTabCount(showKiloClawTab, showQuickChatTab);
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
  const needsInputRows = activeSessions.map(session => ({
    id: session.id,
    status: session.status,
    isAcked: isAttentionAcked(session.id, session.status),
  }));
  const needsInputCount = needsInputRows.filter(session =>
    shouldShowNeedsInput({
      status: session.status,
      raiseId: session.status,
      isAcked: session.isAcked,
    })
  ).length;
  const needsInputBadge =
    orgLoaded && !isLoading && !isError && needsInputCount > 0 ? needsInputCount : undefined;

  // The in-app consumer for an action another surface asked for: the URL rails
  // park one (`action-url-handler.ts`), and a completed StartAgent parks the
  // session it created. The consumer lives in `usePendingAppAction` and is
  // mounted here because this layout owns both the router and the live session
  // list — the destination is decided here and nowhere else.
  usePendingAppAction({ needsInputRows, orgLoaded, isLoading, isError });

  // If the flag flips off while the Chat tab is focused, its `href` becomes
  // null but the route is still mounted — move to Home instead.
  const onChatTab = segments.some(segment => (segment as string) === '(4_chat)');
  useEffect(() => {
    if (!showQuickChatTab && onChatTab) {
      router.replace('/(app)/(tabs)/(0_home)' as Href);
    }
  }, [showQuickChatTab, onChatTab, router]);

  return (
    <StateSurfaceInsets bottomInset={hideTabs ? 0 : tabBarHeight + 16}>
      <Tabs
        screenOptions={{
          headerShown: false,
          freezeOnBlur: true,
          tabBarActiveTintColor: colors.foreground,
          tabBarInactiveTintColor: colors.mutedForeground,
          tabBarBackground: TabBarBackground,
          // The bar is absolutely positioned and Android's edge-to-edge window
          // does not resize for the IME, so the raised keyboard covers the bar's
          // lower half: the icons peek out above it with no label row under them
          // (explorer finding, agents-search-empty). The navigator's built-in
          // hide-on-keyboard steps the whole bar out of the IME's way instead of
          // leaving that clipped strip. The content clearance below the bar does
          // not change, so hiding and restoring it moves nothing.
          tabBarHideOnKeyboard: true,
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
            ...tabBarHorizontalInset,
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
            tabBarLabel: ({ focused }) => <TabBarLabel label={t('tabs.home')} focused={focused} />,
            tabBarIcon: ({ color, focused }) => (
              <House size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
            ),
          }}
          listeners={TAB_PRESS_HAPTICS}
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
              <TabBarLabel
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
            tabBarLabel: ({ focused }) => (
              <TabBarLabel label={t('common.agents')} focused={focused} />
            ),
            tabBarIcon: ({ color, focused }) => (
              <Bot size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
            ),
          }}
          listeners={TAB_PRESS_HAPTICS}
        />
        <Tabs.Screen
          name="(4_chat)"
          options={{
            href: showQuickChatTab ? undefined : null,
            title: t('common.chat'),
            tabBarAccessibilityLabel: tabAccessibilityLabel(
              t('common.chat'),
              tabBarPosition('chat', tabFlags) ?? 3,
              tabCount
            ),
            tabBarLabel: ({ focused }) => (
              <TabBarLabel label={t('common.chat')} focused={focused} />
            ),
            tabBarIcon: ({ color, focused }) => (
              <MessageCircle size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
            ),
          }}
          listeners={TAB_PRESS_HAPTICS}
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
              <TabBarLabel label={t('common.profile')} focused={focused} />
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
