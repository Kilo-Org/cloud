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
import { TabBarLabelContext } from '@/lib/tab-bar-clearance';
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
  const { width, fontScale } = useWindowDimensions();
  const hideTabs = shouldHideTabBar(pathname);
  const showKiloClawTab = useKiloClawTabVisible();
  const showQuickChatTab = useFeatureFlag(FEATURE_FLAG_QUICK_CHAT, false);
  const tabFlags = { showKiloClaw: showKiloClawTab, showQuickChat: showQuickChatTab };
  const tabCount = visibleTabCount(showKiloClawTab, showQuickChatTab);
  // The label box is the tab item minus the bar's side safe areas and the
  // tab item's own padding (subtracted inside `tabLabelFits`). A window whose
  // width was never measured leaves the box unknown — the same missing
  // measurement `shouldStackHeaderActions` treats as its default — so the
  // width rule stays out of it and the font-scale rule alone decides.
  const tabBarContentWidth = width - left - right;
  const tabItemWidth = Number.isFinite(tabBarContentWidth)
    ? tabBarContentWidth / tabCount
    : undefined;
  const { t } = useTranslation();
  const homeLabel = t('tabs.home');
  const kiloclawLabel =
    fontScale > TAB_LABEL_WRAP_FONT_SCALE ? t('tabs.kiloclawWrapped') : t('common.kiloclaw');
  const agentsLabel = t('common.agents');
  const chatLabel = t('common.chat');
  const profileLabel = t('common.profile');
  // The label set in render order, so the visible/dropped decision measures
  // exactly the strings each `TabBarLabel` renders.
  const tabLabels = [
    homeLabel,
    ...(showKiloClawTab ? [kiloclawLabel] : []),
    agentsLabel,
    ...(showQuickChatTab ? [chatLabel] : []),
    profileLabel,
  ];
  const showTabLabel = shouldShowTabLabel(fontScale, tabItemWidth, tabLabels);
  const tabBarHeight = getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
    showLabel: showTabLabel,
  });
  const tabBarHorizontalInset = getTabBarHorizontalInset({ left, right });
  const tabIconSize = getTabBarIconSize(fontScale);
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
  const onChatTab = segments.some(segment => segment === '(4_chat)');
  useEffect(() => {
    if (!showQuickChatTab && onChatTab) {
      router.replace('/(app)/(tabs)/(0_home)' as Href);
    }
  }, [showQuickChatTab, onChatTab, router]);

  // The label decision is published to the tab screens, whose content
  // clearance must match the height this layout renders (the width rule can
  // drop the labels without the callers seeing the window width).
  const tabsLayout = (
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
            tabBarLabel: ({ focused }) => <TabBarLabel label={homeLabel} focused={focused} />,
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
            // The pre-wrapped copy is chosen once, from the same font scale the
            // width decision measures, so `tabLabels` and the rendered label
            // cannot disagree about which string is on the bar.
            tabBarLabel: ({ focused }) => <TabBarLabel label={kiloclawLabel} focused={focused} />,
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
            tabBarLabel: ({ focused }) => <TabBarLabel label={agentsLabel} focused={focused} />,
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
            tabBarLabel: ({ focused }) => <TabBarLabel label={chatLabel} focused={focused} />,
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
            tabBarLabel: ({ focused }) => <TabBarLabel label={profileLabel} focused={focused} />,
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
  return <TabBarLabelContext value={showTabLabel}>{tabsLayout}</TabBarLabelContext>;
}
