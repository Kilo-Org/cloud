import { type ReactNode } from 'react';
import { View } from 'react-native';
import { type TFunction } from 'i18next';

import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type RenderProfileRowArgs = {
  isProfileLoading: boolean;
  t: TFunction;
  profile: ProfileRowProfile | null;
  isProfileError: boolean;
  onRetryProfile: () => void;
};

/** The capability summary the row renders; a full profile is assignable. */
type ProfileRowProfile = Pick<
  EffectiveAgentProfile,
  'name' | 'commandCount' | 'mcpServerCount' | 'skillCount' | 'agentCount'
>;

/**
 * Keep the environment visible while it gates Start, without showing a default
 * before the query settles. Every state reserves the same two text lines.
 *
 * This module stays free of the app's icon barrel: the mounted suite that
 * renders it cannot load `lucide-react-native`, so the tappable
 * `NewSessionProfileRow` (which needs the chevron) lives with its screen.
 */
export function renderProfileRow({
  t,
  profile,
  isProfileLoading,
  isProfileError,
  onRetryProfile,
}: Readonly<RenderProfileRowArgs>): ReactNode {
  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.environment')}
      </Text>
      {renderProfileRowBody({ t, profile, isProfileLoading, isProfileError, onRetryProfile })}
    </View>
  );
}

/**
 * The state body without the Environment label. `NewSessionProfileRow` reuses
 * it for its loading and failure states so both rows reserve the same lines.
 */
export function renderProfileRowBody({
  t,
  profile,
  isProfileLoading,
  isProfileError,
  onRetryProfile,
}: Readonly<RenderProfileRowArgs>): ReactNode {
  let title = t('agentChat.newSession.defaultEnvironment');
  let summary: string | undefined = undefined;
  const showError = isProfileError && !isProfileLoading;
  if (isProfileLoading) {
    title = t('common.loading');
  } else if (showError) {
    title = t('agentChat.newSession.couldNotLoadEnvironment');
  } else if (profile) {
    title = profile.name;
    summary = t('agentChat.newSession.environmentSummary', {
      commands: profile.commandCount,
      mcp: profile.mcpServerCount,
      skills: profile.skillCount,
      agents: profile.agentCount,
    });
  }

  return (
    <View className="min-h-[36px] flex-row items-center gap-2">
      <View className="min-w-0 flex-1 gap-1">
        <Text
          className={cn(
            'text-sm leading-5 text-foreground',
            isProfileLoading && 'text-muted-foreground',
            showError && 'text-destructive',
            summary && 'font-semibold'
          )}
          numberOfLines={1}
          accessibilityLiveRegion="polite"
          accessibilityState={{ busy: isProfileLoading }}
        >
          {title}
        </Text>
        <View
          accessibilityElementsHidden={!summary}
          importantForAccessibility={summary ? 'auto' : 'no-hide-descendants'}
        >
          {/* A text line reserves the summary's height even at larger system font sizes. */}
          <Text className="text-sm leading-5 text-muted-foreground" numberOfLines={1}>
            {summary ?? '\u00A0'}
          </Text>
          {isProfileLoading ? (
            <Skeleton className="absolute inset-y-0 left-0 w-2/3 rounded" />
          ) : null}
        </View>
      </View>
      {showError ? (
        <Button
          variant="link"
          size="sm"
          onPress={onRetryProfile}
          accessibilityLabel={t('agentChat.newSession.retryLoadingEnvironment')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
