import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { renderProfileRowBody } from '@/components/agents/new-session-profile-row';
import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { ChevronDown } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { formatProfileCountItems, profileCountItems } from '@/lib/profile-count-labels';
import { cn } from '@/lib/utils';

export type NewSessionProfileRowProps = {
  profile: EffectiveAgentProfile | null;
  isProfileLoading: boolean;
  isProfileError: boolean;
  /** The picked override no longer resolves to a profile. */
  overrideNeedsAttention: boolean;
  onRetryProfile: () => void;
  /** Opens the profile picker sheet. */
  onOpenProfilePicker: () => void;
};

/**
 * The card every Environment row state renders inside. The chrome lives on the
 * card rather than on the tappable branch, so loading, failure and every
 * settled profile occupy the same box.
 */
const ENVIRONMENT_ROW_CARD = cn(
  ROW_TARGET_CLASS,
  'flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5'
);

/**
 * The new-session Environment row: a tappable summary of the effective profile.
 * Loading, failure and every settled profile occupy the same card and reserve
 * the same two-line summary slot, so the row never changes height as the query
 * settles or as the counts change length.
 */
export function NewSessionProfileRow({
  profile,
  isProfileLoading,
  isProfileError,
  overrideNeedsAttention,
  onRetryProfile,
  onOpenProfilePicker,
}: Readonly<NewSessionProfileRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const profileSummary = profile
    ? formatProfileCountItems(t, profileCountItems(profile)).join(' · ')
    : '';
  const hasSummary = profileSummary.length > 0;
  // The card is one accessible control, so its label has to carry what it
  // shows and what it does: the pick purpose (Android ignores
  // `accessibilityHint`, so the purpose lives here), the active choice (the
  // picked profile or the default environment) and the attention line, which
  // a child Text would not be read as. The purpose is part of each catalog's
  // sentence, not an interpolated label of its own, because several locales
  // write that action as a full sentence with its own terminal mark.
  const selectedLabel = profile?.name ?? t('agentChat.newSession.defaultEnvironment');
  const accessibilityLabel = overrideNeedsAttention
    ? t('agentChat.newSession.environmentAccessibilityNeedsAttention', {
        label: selectedLabel,
        attention: t('agentChat.newSession.configNeedsAttention'),
      })
    : t('agentChat.newSession.environmentAccessibility', { label: selectedLabel });
  const attention = overrideNeedsAttention ? (
    <Text className="text-sm text-warn">{t('agentChat.newSession.configNeedsAttention')}</Text>
  ) : null;

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.environment')}
      </Text>
      {isProfileLoading || isProfileError ? (
        <View className={cn(ENVIRONMENT_ROW_CARD, 'justify-between')}>
          <View className="min-w-0 flex-1 gap-1">
            {attention}
            {renderProfileRowBody({ t, profile, isProfileLoading, isProfileError, onRetryProfile })}
          </View>
        </View>
      ) : (
        <Pressable
          className={cn(ENVIRONMENT_ROW_CARD, 'justify-between active:opacity-70')}
          onPress={onOpenProfilePicker}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <View className="min-w-0 flex-1 gap-1">
            {attention}
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {profile?.name ?? t('agentChat.newSession.defaultEnvironment')}
            </Text>
            <View
              accessibilityElementsHidden={!hasSummary}
              importantForAccessibility={hasSummary ? 'auto' : 'no-hide-descendants'}
            >
              {/* A one-line summary still fills both matching lines through
                  `min-h-10`, and an unconfigured profile keeps the two-line
                  placeholder, so the card never shrinks as counts load. */}
              <Text className="min-h-10 text-sm text-muted-foreground" numberOfLines={2}>
                {hasSummary ? profileSummary : '\u00A0\n\u00A0'}
              </Text>
            </View>
          </View>
          <ChevronDown size={18} color={colors.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}
