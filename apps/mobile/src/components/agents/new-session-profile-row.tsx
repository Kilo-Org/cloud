import { type ReactNode } from 'react';
import { View } from 'react-native';
import { type TFunction } from 'i18next';

import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type RenderProfileRowArgs = RenderProfileBodyArgs & {
  isProfileLoading: boolean;
};

type RenderProfileBodyArgs = {
  t: TFunction;
  profile: EffectiveAgentProfile | null;
  isProfileError: boolean;
  onRetryProfile: () => void;
};

/**
 * Read-only effective-profile row. Hidden while the profile query loads so a
 * resolved name never flashes a "Default environment" placeholder first.
 */
export function renderProfileRow({
  t,
  profile,
  isProfileLoading,
  isProfileError,
  onRetryProfile,
}: Readonly<RenderProfileRowArgs>): ReactNode {
  if (isProfileLoading) {
    return null;
  }
  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.environment')}
      </Text>
      {renderProfileBody({ t, profile, isProfileError, onRetryProfile })}
    </View>
  );
}

function renderProfileBody({
  t,
  profile,
  isProfileError,
  onRetryProfile,
}: Readonly<RenderProfileBodyArgs>): ReactNode {
  if (isProfileError) {
    return (
      <View className="flex-row items-center gap-2">
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
  return profile ? (
    <View className="gap-1">
      <Text className="text-sm font-semibold text-foreground">{profile.name}</Text>
      <Text className="text-sm text-muted-foreground">
        {t('agentChat.newSession.environmentSummary', {
          commands: profile.commandCount,
          mcp: profile.mcpServerCount,
          skills: profile.skillCount,
          agents: profile.agentCount,
        })}
      </Text>
    </View>
  ) : (
    <Text className="text-sm text-foreground">{t('agentChat.newSession.defaultEnvironment')}</Text>
  );
}
