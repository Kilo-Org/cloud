import { type ReactNode } from 'react';
import { View } from 'react-native';
import { type TFunction } from 'i18next';

import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
    // A profile with nothing configured resolves no counts. Treat that as no
    // summary, so the slot keeps its placeholder instead of collapsing.
    const counts = formatProfileCountItems(t, profileCountItems(profile)).join(' · ');
    summary = counts.length > 0 ? counts : undefined;
  }

  return (
    <View className="min-h-[36px] flex-row items-center gap-2">
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
        <View
          accessibilityElementsHidden={!summary}
          importantForAccessibility={summary ? 'auto' : 'no-hide-descendants'}
        >
          {/* The summary may wrap to a second line in long locales, so every
              state holds both lines: `min-h-10` keeps a one-line summary at the
              placeholder's height, and the placeholder itself spans two lines. */}
          <Text
            className="min-h-10 text-sm leading-[1.25rem] text-muted-foreground"
            numberOfLines={2}
          >
            {summary ?? '\u00A0\n\u00A0'}
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
