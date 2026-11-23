import { type ReactNode } from 'react';
import { View } from 'react-native';
import { type TFunction } from 'i18next';

import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { Button } from '@/components/ui/button';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Text } from '@/components/ui/text';
import {
  formatProfileCountItems,
  type ProfileCountCounts,
  profileCountItems,
} from '@/lib/profile-count-labels';
import { cn } from '@/lib/utils';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';

type RenderProfileRowArgs = {
  isProfileLoading: boolean;
  t: TFunction;
  profile: ProfileRowProfile | null;
  isProfileError: boolean;
  onRetryProfile: () => void;
};

/** The capability summary the row renders; a full profile is assignable. */
type ProfileRowProfile = Pick<EffectiveAgentProfile, 'name'> & ProfileCountCounts;

/**
 * Keep the environment visible while it gates Start, without showing a default
 * before the query settles. Every state renders the same card; a state with no
 * counts is its one title line, and a summary adds its own line.
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
    <View className="gap-2">
      <FormFieldLabel label={t('agentChat.newSession.environment')} />
      {renderProfileRowBody({ t, profile, isProfileLoading, isProfileError, onRetryProfile })}
    </View>
  );
}

/**
 * The state body without the Environment label. `NewSessionProfileRow` reuses
 * it for its loading and failure states so both rows share one card shape: a
 * title line, plus the summary when the state has one.
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
    // A profile with nothing configured resolves no counts. Treat that as no
    // summary, so the card keeps its title line alone.
    const counts = formatProfileCountItems(t, profileCountItems(profile)).join(' · ');
    summary = counts.length > 0 ? counts : undefined;
  }

  return (
    <View className="flex-row items-center gap-2">
      <View className="min-w-0 flex-1 gap-1">
        <Text
          className={cn(
            'text-sm leading-[1.25rem] text-foreground',
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
        {/* The summary may wrap to a second line in long locales, and no state
            reserves a blank one: the card is its title line until a summary
            exists, then exactly as tall as that summary. */}
        {summary === undefined ? null : (
          <Text className="text-sm leading-[1.25rem] text-muted-foreground" numberOfLines={2}>
            {summary}
          </Text>
        )}
      </View>
      {showError ? (
        <Button
          variant="link"
          size="sm"
          className={STATE_ACTION_CLASS}
          onPress={onRetryProfile}
          accessibilityLabel={t('agentChat.newSession.retryLoadingEnvironment')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
