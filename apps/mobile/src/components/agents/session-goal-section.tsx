import { type SessionGoal, type SessionGoalStatus } from '@kilocode/cloud-agent-sdk';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  DisclosureChevron,
  DisclosureLayout,
} from '@/components/security-agent/collapsible-section';
import { CircleDot } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const STATUS_LABEL_KEY = {
  active: 'agentChat.goal.statusActive',
  paused: 'agentChat.goal.statusPaused',
  complete: 'agentChat.goal.statusComplete',
  blocked: 'agentChat.goal.statusBlocked',
} as const satisfies Record<SessionGoalStatus, string>;

type SessionGoalSectionProps = {
  goal: SessionGoal | null;
  /** Collapsed shows the icon and the status only; the parent owns the value. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onPress: () => void;
  /**
   * Sits at the row end, between the goal pressable and the chevron. The PR
   * link rides here so the goal status and the pull request share one row;
   * with no goal the row renders the trailing control alone, reserving the
   * chevron's box so the control keeps one right edge across both.
   */
  trailing?: ReactNode;
};

/**
 * Fixed goal row shown under the session header. It lives outside the
 * transcript list, so it stays put while the transcript scrolls. The
 * `min-h-*` reserves the row height across every status, and the optional
 * `reason` is the only part that can add a line.
 *
 * The disclosure pressable is a sibling of the action pressable: a nested
 * pressable disappears from assistive technology inside an accessible parent.
 * The action pressable stretches to the reserved row height (`self-stretch`)
 * so the whole row answers the tap and reaches the touch-target minimum, while
 * its own content stays top-aligned.
 * The row only owns its own top padding (`pt-0.5`); the header's own spacing is
 * deliberately untouched, and the content stays top-aligned in both states so
 * collapsing never moves the status line the reader is on.
 *
 * The carat rotation and the height transition are the app's shared disclosure
 * primitives (Reanimated, one implementation on iOS and Android), not a
 * second copy of the animation.
 *
 * The row is shared with the pull-request link (`trailing`), which keeps the
 * header to two rows. With no goal it renders the trailing control in the same
 * shell without the chevron or the goal accessibility state, reserving the
 * chevron's 24px box so the control's right edge is the same one it has beside
 * a goal (the row's `gap-2` adds the same 8px in both).
 */
export function SessionGoalSection({
  goal,
  collapsed,
  onToggleCollapsed,
  onPress,
  trailing,
}: Readonly<SessionGoalSectionProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  const trailingSlot = trailing ? (
    <View className="ml-auto shrink-0 self-start pt-0.5">{trailing}</View>
  ) : null;

  // The disclosure chevron is `h-6 w-6`; a PR-only row still reserves that box
  // so the trailing control's right edge matches the goal+PR row instead of
  // sliding 24px (plus the row's 8px gap) closer to the row edge.
  const chevronGutter = trailing ? <View className="h-6 w-6 shrink-0" /> : null;

  if (!goal) {
    return (
      <DisclosureLayout>
        <View className="min-h-12 flex-row items-start gap-2 border-b border-hair-soft px-4 pt-0.5 pb-2">
          {trailingSlot}
          {chevronGutter}
        </View>
      </DisclosureLayout>
    );
  }

  const isActive = goal.status === 'active';
  const status = t(STATUS_LABEL_KEY[goal.status]);

  return (
    <DisclosureLayout>
      <View className="min-h-12 flex-row items-start gap-2 border-b border-hair-soft px-4 pt-0.5 pb-2">
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={
            collapsed
              ? status
              : t('agentChat.goal.sectionAccessibility', { status, text: goal.text })
          }
          className="min-w-0 flex-1 self-stretch flex-row items-start gap-2 active:opacity-70"
        >
          <View className="pt-0.5">
            <CircleDot size={14} color={isActive ? colors.primary : colors.mutedForeground} />
          </View>
          <View className="min-w-0 flex-1">
            <Text className={cn('text-xs', isActive ? 'text-primary' : 'text-muted-foreground')}>
              {status}
            </Text>
            {collapsed ? null : (
              <>
                <Text className="text-sm text-foreground" numberOfLines={2}>
                  {goal.text}
                </Text>
                {goal.reason ? (
                  <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                    {goal.reason}
                  </Text>
                ) : null}
              </>
            )}
          </View>
        </Pressable>
        {trailingSlot}
        <DisclosureChevron
          expanded={!collapsed}
          label={collapsed ? t('agentChat.goal.expand') : t('agentChat.goal.collapse')}
          onPress={onToggleCollapsed}
        />
      </View>
    </DisclosureLayout>
  );
}
