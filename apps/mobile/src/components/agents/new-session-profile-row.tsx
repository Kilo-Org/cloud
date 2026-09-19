import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type TFunction } from 'i18next';

import { ActiveProfileIndicator } from '@/components/agents/active-profile-indicator';
import { buildActiveProfileIndicatorState } from '@/components/agents/active-profile-indicator-model';
import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { Button } from '@/components/ui/button';
import { ChevronDown } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type NewSessionProfileRowProps = {
  profile: EffectiveAgentProfile | null;
  isProfileLoading: boolean;
  isProfileError: boolean;
  /** The picked override no longer resolves to a profile. */
  overrideNeedsAttention: boolean;
  onRetryProfile: () => void;
  /** Opens the profile picker sheet. */
  onOpenProfilePicker: () => void;
};

type ProfileBodyProps = NewSessionProfileRowProps & {
  t: TFunction;
  mutedForeground: string;
};

/**
 * The new-session Environment row: a tappable summary of the effective profile
 * with the active-profile indicator beside its label. While the profiles load
 * the row keeps the same height with skeletons, so the name never flashes a
 * placeholder and the rows below never move.
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

  const indicatorState = buildActiveProfileIndicatorState({
    selectedProfileName: profile?.name ?? null,
    repoBoundProfileName: null,
    hasManualEnvVars: false,
    hasManualSetupCommands: false,
    hasSelectedProfileId: profile !== null || overrideNeedsAttention,
    isProfilesLoading: isProfileLoading,
    hasProfileError: isProfileError,
  });

  return (
    <View className="mt-5">
      <View className="mb-2 flex-row items-center justify-between gap-2">
        <Text className="text-sm font-medium text-muted-foreground">
          {t('agentChat.newSession.environment')}
        </Text>
        <ActiveProfileIndicator state={indicatorState} onPress={onOpenProfilePicker} />
      </View>
      {renderProfileBody({
        t,
        mutedForeground: colors.mutedForeground,
        profile,
        isProfileLoading,
        isProfileError,
        overrideNeedsAttention,
        onRetryProfile,
        onOpenProfilePicker,
      })}
    </View>
  );
}

function renderProfileBody({
  t,
  mutedForeground,
  profile,
  isProfileLoading,
  isProfileError,
  overrideNeedsAttention,
  onRetryProfile,
  onOpenProfilePicker,
}: Readonly<ProfileBodyProps>) {
  if (isProfileLoading) {
    return (
      <View className="gap-1.5">
        <Skeleton className="h-6 w-40 rounded-md" />
        <Skeleton className="h-4 w-56 rounded-md" />
      </View>
    );
  }
  if (isProfileError) {
    return (
      <View className="min-h-11 flex-row items-center gap-2">
        <Text className="text-sm text-destructive">
          {t('agentChat.newSession.couldNotLoadEnvironment')}
        </Text>
        <Button
          variant="link"
          size="sm"
          onPress={onRetryProfile}
          accessibilityLabel={t('agentChat.newSession.retryLoadingEnvironment')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  }
  return (
    <Pressable
      className="min-h-11 flex-row items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 active:opacity-70"
      onPress={onOpenProfilePicker}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.newSession.pickProfile')}
    >
      <View className="min-w-0 flex-1 gap-1">
        {overrideNeedsAttention ? (
          <Text className="text-sm text-warn">
            {t('agentChat.newSession.configNeedsAttention')}
          </Text>
        ) : null}
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {profile?.name ?? t('agentChat.newSession.defaultEnvironment')}
        </Text>
        {profile ? (
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {t('agentChat.newSession.environmentSummary', {
              commands: profile.commandCount,
              mcp: profile.mcpServerCount,
              skills: profile.skillCount,
              agents: profile.agentCount,
            })}
          </Text>
        ) : null}
      </View>
      <ChevronDown size={18} color={mutedForeground} />
    </Pressable>
  );
}
