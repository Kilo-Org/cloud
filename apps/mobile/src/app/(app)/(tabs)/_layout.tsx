import * as Haptics from 'expo-haptics';
import { Tabs, usePathname, useRouter, useSegments } from 'expo-router';
import { Bot, House, MessageCircle, MessageSquare, UserRound } from '@/components/ui/icons';
import { useEffect } from 'react';
import { Platform, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { SessionPreviewOverlay } from '@/components/agents/session-preview-overlay';
import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { TabBarButton } from '@/components/tab-bar-button';
import { TabBarLabel } from '@/components/tab-bar-label';
import { TabSwitchInputGate } from '@/components/tab-screen-input-gate';
import { BlurBar } from '@/components/ui/blur-bar';
import { usePendingAppAction } from '@/lib/app-actions/use-pending-app-action';
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
import { profileTabPressListeners, tabPressListeners } from '@/lib/tab-press-listeners';
import {
  getEffectiveTabBarHeight,
  getTabBarHorizontalInset,
  getTabBarIconSize,
  shouldHideTabBar,
  shouldShowTabLabel,
  TAB_LABEL_WRAP_FONT_SCALE,
  tabAccessibilityLabel,
  tabBarPosition,
  tabLabelLines,
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

export default function TabsLayout() {
  const pathname = usePathname();
  const segments = useSegments();
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom, left, right } = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const hideTabs = shouldHideTabBar(pathname, segments);
  const showKiloClawTab = useKiloClawTabVisible();
  const tabFlags = { showKiloClaw: showKiloClawTab };
  const tabCount = visibleTabCount(showKiloClawTab);
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
  const kiloclawLabel =
    fontScale > TAB_LABEL_WRAP_FONT_SCALE ? t('tabs.kiloclawWrapped') : t('common.kiloclaw');
  const agentsLabel = t('common.agents');
  const chatLabel = t('common.chat');
  const profileLabel = t('common.profile');
  // Each tab decides its own lines, so one label that does not fit its tab
  // takes a second line or shrinks instead of dropping every label. The bar
  // reserves the tallest line count any visible tab needs.
  const homeLines = tabLabelLines(homeLabel, tabItemWidth, fontScale);
  const kiloclawLines = tabLabelLines(kiloclawLabel, tabItemWidth, fontScale);
  const agentsLines = tabLabelLines(agentsLabel, tabItemWidth, fontScale);
  const chatLines = tabLabelLines(chatLabel, tabItemWidth, fontScale);
  const profileLines = tabLabelLines(profileLabel, tabItemWidth, fontScale);
  const labelLines = Math.max(
    homeLines,
    agentsLines,
    chatLines,
    profileLines,
    showKiloClawTab ? kiloclawLines : 1
  ) as 1 | 2;
  const showTabLabel = shouldShowTabLabel(fontScale);
  const tabBarHeight = getEffectiveTabBarHeight({
    bottomInset: bottom,
    platform: Platform.OS,
    fontScale,
    showLabel: showTabLabel,
    labelLines,
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
  // The label decision is published to the tab screens, whose content
  // clearance must match the height this layout renders (the width rule can
  // drop the labels without the callers seeing the window width).
  const tabsLayout = (
    <StateSurfaceInsets bottomInset={hideTabs ? 0 : tabBarHeight}>
      <Tabs
        screenOptions={{
          headerShown: false,
          freezeOnBlur: true,
          // The row palette colours a destination inside a screen; a tab tint
          // says which tab is selected — a state, not a destination. One accent
          // per tab would put six accents on the bar and fight the rows below
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
              tabBarPosition('home', tabFlags) ?? 1,
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
            tabBarLabel: ({ focused }) => (
              <TabBarLabel label={kiloclawLabel} focused={focused} lines={kiloclawLines} />
            ),
            tabBarIcon: ({ color, focused }) => (
              <MessageSquare size={tabIconSize} color={color} strokeWidth={focused ? 2 : 1.5} />
            ),
          }}
          listeners={{
            tabPress: event => {
              void Haptics.selectionAsync();
              event.preventDefault();
              router.navigate('/(app)/(tabs)/(1_kiloclaw)');
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
              tabBarPosition('chat', tabFlags) ?? 3,
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
    <TabBarLabelContext value={{ showLabel: showTabLabel, labelLines }}>
      <TabSwitchInputGate>{tabsLayout}</TabSwitchInputGate>
      <SessionPreviewOverlay />
    </TabBarLabelContext>
  );
}
