import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from '@/components/ui/icons';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  PROVIDER_COPY,
  providerNeedsAttentionCopy,
  providerPartialNoticeKey,
} from './repository-provider-copy';
import { type RepositoryPlatform } from './new-session-repository-state';

type RepositoryCardActionsProps = {
  platform: RepositoryPlatform;
  onConnect: (platform: RepositoryPlatform) => void;
  onRefreshRepos: () => void;
  isRetrying: boolean;
};

/** The one refresh control every repository card offers, named for the list. */
export function RepositoryRefreshButton({
  onRefreshRepos,
  isRetrying,
}: {
  onRefreshRepos: () => void;
  isRetrying: boolean;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="icon"
      onPress={onRefreshRepos}
      disabled={isRetrying}
      accessibilityLabel={t('agentChat.newSession.refreshRepositories')}
    >
      {isRetrying ? (
        <ActivityIndicator size="small" color={colors.foreground} />
      ) : (
        <RefreshCw size={16} color={colors.foreground} />
      )}
    </Button>
  );
}

/**
 * The provider's open action plus its refresh. `labelKey` overrides the label a
 * provider would show by default; the open label already reads as the action
 * the card asks for.
 */
export function RepositoryActionRow({
  platform,
  labelKey,
  onConnect,
  onRefreshRepos,
  isRetrying,
}: RepositoryCardActionsProps & { labelKey: string }) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  // The label takes the row's remaining width and is pinned to one line: a
  // label sized to its own content is measured at its longest word's width and
  // wraps onto a second line the button's min height then clips. The logical
  // `me-[24px]` inset keeps the centred label clear of the leading glyph in RTL
  // as well, which a physical `mr-` would not. The explorer captures
  // new-session-filled and new-session-kb-down both showed that wrap.
  return (
    <View className="flex-row gap-2">
      <Button
        variant="outline"
        className="flex-1"
        onPress={() => {
          onConnect(platform);
        }}
      >
        <ExternalLink size={16} color={colors.foreground} />
        <Text className="me-[24px] flex-1 text-center" numberOfLines={1}>
          {t(labelKey)}
        </Text>
      </Button>
      <RepositoryRefreshButton onRefreshRepos={onRefreshRepos} isRetrying={isRetrying} />
    </View>
  );
}

/**
 * A provider whose stored installation cannot list repositories: the person
 * reconnects it, so the card names that step and offers the settings link
 * instead of asking them to connect the provider for the first time.
 */
export function RepositoryUnavailableCard({
  platform,
  onConnect,
  onRefreshRepos,
  isRetrying,
}: RepositoryCardActionsProps) {
  const { t } = useTranslation();
  const attention = providerNeedsAttentionCopy(platform);
  if (attention === null) {
    return null;
  }
  return (
    <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">{t(attention.title)}</Text>
        <Text variant="muted">{t(attention.description)}</Text>
      </View>
      <RepositoryActionRow
        platform={platform}
        labelKey={PROVIDER_COPY[platform].openLabel}
        onConnect={onConnect}
        onRefreshRepos={onRefreshRepos}
        isRetrying={isRetrying}
      />
    </View>
  );
}

/**
 * A provider that answered with only some of its installations' repositories.
 * The rows it did return stay selectable, and the notice says the list is short.
 */
export function RepositoryPartialNotice({
  platform,
  onRefreshRepos,
  isRetrying,
}: {
  platform: RepositoryPlatform;
  onRefreshRepos: () => void;
  isRetrying: boolean;
}) {
  const { t } = useTranslation();
  const key = providerPartialNoticeKey(platform);
  if (key === null) {
    return null;
  }
  return (
    <View className="mt-3 flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <Text variant="muted" className="flex-1">
        {t(key)}
      </Text>
      <RepositoryRefreshButton onRefreshRepos={onRefreshRepos} isRetrying={isRetrying} />
    </View>
  );
}
