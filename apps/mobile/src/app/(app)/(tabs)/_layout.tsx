import { Tabs, usePathname, useSegments } from 'expo-router';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { Bot, House, MessageCircle, UserRound } from '@/components/ui/icons';
import { useEffect, useMemo } from 'react';
import { Platform, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { SessionPreviewOverlay } from '@/components/agents/session-preview-overlay';
import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { TabBarButton } from '@/components/tab-bar-button';
import { TabBarLabel } from '@/components/tab-bar-label';
import { TabSwitchInputSettle } from '@/components/tab-screen-input-gate';
import { BlurBar } from '@/components/ui/blur-bar';
import { usePendingAppAction } from '@/lib/app-actions/use-pending-app-action';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import { publishRenderedTabBarHeight, TabBarLabelContext } from '@/lib/tab-bar-clearance';
import { profileTabPressListeners, tabPressListeners } from '@/lib/tab-press-listeners';
import {
  getEffectiveTabBarHeight,
  getTabBarHorizontalInset,
  getTabBarIconSize,
  shouldHideTabBar,
  shouldShowTabLabel,
  tabAccessibilityLabel,
  tabBarPosition,
  tabLabelLines,
  VISIBLE_TAB_COUNT,
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

export default function TabsLayout() {
  const pathname = usePathname();
  const segments = useSegments();
  const colors = useThemeColors();
  const { bottom, left, right } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const fontScale = useLiveFontScale();
  const hideTabs = shouldHideTabBar(pathname, segments);
  const tabCount = VISIBLE_TAB_COUNT;
  // The label box is the tab item minus the bar's side safe areas and the
  // tab item's own padding (subtracted inside `tabLabelFits`). A window whose
  // width was never measured leaves the box unknown, so it is treated as
  // unbounded and every label keeps one line.
  const tabBarContentWidth = width - left - right;
  const tabItemWidth = Number.isFinite(tabBarContentWidth)
    ? tabBarContentWidth / tabCount
    : Number.POSITIVE_INFINITY;
  const { t } = useTranslation();
  const homeLabel = t('tabs.home');
  const agentsLabel = t('common.agents');
  const chatLabel = t('common.chat');
  const profileLabel = t('common.profile');
  // Each surviving tab keeps its own line count; reserve the tallest label.
  const homeLines = tabLabelLines(homeLabel, tabItemWidth, fontScale);
  const agentsLines = tabLabelLines(agentsLabel, tabItemWidth, fontScale);
  const chatLines = tabLabelLines(chatLabel, tabItemWidth, fontScale);
  const profileLines = tabLabelLines(profileLabel, tabItemWidth, fontScale);
  const labelLines = Math.max(homeLines, agentsLines, chatLines, profileLines) as 1 | 2;
  const showTabLabel = shouldShowTabLabel(fontScale);
  const labelState = useMemo(
    () => ({ showLabel: showTabLabel, labelLines }),
    [showTabLabel, labelLines]
  );
  const tabBarHeight = getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
    showLabel: showTabLabel,
    labelLines,
  });
  const tabBarHorizontalInset = getTabBarHorizontalInset({ left, right });
  // The toaster sits above this navigator, so it cannot read the label context:
  // publish the bar it must clear, and withdraw it when the bar is off screen or
  // this navigator unmounts.
  useEffect(() => {
    publishRenderedTabBarHeight(hideTabs ? null : tabBarHeight);
    return () => {
      publishRenderedTabBarHeight(null);
    };
  }, [hideTabs, tabBarHeight]);
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
    isAcked: isAttentionAcked(session.id, {
      raiseId: session.statusUpdatedAt ?? session.status,
      status: session.status,
    }),
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

  // The centered-state band ends at the tab bar's top edge, the region the bar
  // does not cover. The 16pt scroll-content gap (`TAB_SCREEN_BOTTOM_GAP`) is
  // breathing room for the last row of a scrolling list, not part of the
  // overlay; reserving it here shrank the band below the empty state's height
  // in a short landscape window and parked its second line and action behind
  // the bar (landscape spot defect e8).
  //
  // Publish the label decision so each tab screen clears the same height,
  // including the second line a narrow tab's label may need.
  const tabsLayout = (
    <StateSurfaceInsets bottomInset={hideTabs ? 0 : tabBarHeight}>
      <Tabs
        screenLayout={TabSwitchInputSettle}
        screenOptions={{
          headerShown: false,
          // The row palette colours a destination inside a screen; a tab tint
          // says which tab is selected — a state, not a destination. One accent
          // per tab would put four accents on the bar and fight the rows below
          // it, and an icon-only recolour would disagree with `TabBarLabel`,
          // which draws its label from its own `text-foreground` /
          // `text-muted-foreground` classes and ignores the navigator tint.
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
          tabBarButton: TabBarButton,
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
              tabBarPosition('home'),
              tabCount
            ),
            tabBarLabel: ({ focused }) => (
              <TabBarLabel label={homeLabel} focused={focused} lines={homeLines} />
            ),
            tabBarIcon: ({ color, focused }) => (
              <House size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
            ),
          }}
          listeners={tabPressListeners}
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
              tabBarPosition('agents'),
              tabCount
            ),
            tabBarLabel: ({ focused }) => (
              <TabBarLabel label={agentsLabel} focused={focused} lines={agentsLines} />
            ),
            tabBarIcon: ({ color, focused }) => (
              <Bot size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
            ),
          }}
          listeners={tabPressListeners}
        />
        <Tabs.Screen
          name="(4_chat)"
          options={{
            title: t('common.chat'),
            tabBarAccessibilityLabel: tabAccessibilityLabel(
              t('common.chat'),
              tabBarPosition('chat'),
              tabCount
            ),
            tabBarLabel: ({ focused }) => (
              <TabBarLabel label={chatLabel} focused={focused} lines={chatLines} />
            ),
            tabBarIcon: ({ color, focused }) => (
              <MessageCircle size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
            ),
          }}
          listeners={tabPressListeners}
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
              <TabBarLabel label={profileLabel} focused={focused} lines={profileLines} />
            ),
            tabBarIcon: ({ color, focused }) => (
              <UserRound size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
            ),
          }}
          listeners={profileTabPressListeners(segments)}
        />
      </Tabs>
    </StateSurfaceInsets>
  );
  return (
    <TabBarLabelContext value={labelState}>
      {tabsLayout}
      <SessionPreviewOverlay />
    </TabBarLabelContext>
  );
}
