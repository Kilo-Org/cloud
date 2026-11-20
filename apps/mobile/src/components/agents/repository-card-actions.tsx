import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from '@/components/ui/icons';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { providerLabelKey } from '@/lib/integrations/provider-catalog';
import {
  PROVIDER_COPY,
  providerNeedsAttentionCopy,
  providerPartialNoticeKey,
} from './repository-provider-copy';
import { type RepositoryPlatform } from './new-session-repository-state';

type RepositoryCardActionsProps = {
  platform: RepositoryPlatform;
  onConnect: (platform: RepositoryPlatform) => void;
  /**
   * The provider's connect flow is running. The open control disables and shows
   * its spinner: the flow's first step is a network round trip, and without the
   * busy state the tap reads as inert until that round trip settles.
   */
  isConnecting?: boolean;
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
 * The accessible name of a provider's action. The visible label can be a bare
 * verb ("Connect" under a card title that already names the provider), so the
 * name adds the provider only when the label does not carry it: a label that
 * already reads "Open GitHub" must not announce GitHub a second time. Brand
 * names are not translated, so the comparison is case-insensitive and safe in
 * every catalog.
 */
export function repositoryActionAccessibleLabel(input: {
  action: string;
  provider: string;
  joiner: string;
}): string {
  const { action, provider, joiner } = input;
  return action.toLocaleLowerCase().includes(provider.toLocaleLowerCase())
    ? action
    : [action, provider].join(joiner);
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
  isConnecting = false,
  onRefreshRepos,
  isRetrying,
}: RepositoryCardActionsProps & { labelKey: string }) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  // A screen-reader user swiping controls hears which provider each one opens.
  // The name repeats the provider only when the visible label leaves it out.
  const accessibilityLabel = repositoryActionAccessibleLabel({
    action: t(labelKey),
    provider: t(providerLabelKey(platform)),
    joiner: t('common.sentenceJoiner'),
  });
  // The icon and the label share the row's centre as one group, so the glyph
  // sits beside its text instead of at the start edge. The label stays on one
  // line; a label wider than the button ellipsizes rather than wrapping into
  // the button's min height.
  return (
    <View className="flex-row gap-2">
      <Button
        variant="outline"
        className="flex-1"
        onPress={() => {
          onConnect(platform);
        }}
        accessibilityLabel={accessibilityLabel}
        // `loading` paints the spinner over the label, so the row keeps exactly
        // its width while the connect flow runs.
        disabled={isConnecting}
        loading={isConnecting}
      >
        <ExternalLink size={16} color={colors.foreground} />
        <Text className="shrink text-center" numberOfLines={1}>
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
  isConnecting = false,
  onRefreshRepos,
  isRetrying,
}: RepositoryCardActionsProps) {
  const { t } = useTranslation();
  const attention = providerNeedsAttentionCopy(platform);
  if (attention === null) {
    return null;
  }
  return (
    <Card className="mt-4">
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">{t(attention.title)}</Text>
        <Text variant="muted">{t(attention.description)}</Text>
      </View>
      <RepositoryActionRow
        platform={platform}
        labelKey={PROVIDER_COPY[platform].openLabel}
        onConnect={onConnect}
        isConnecting={isConnecting}
        onRefreshRepos={onRefreshRepos}
        isRetrying={isRetrying}
      />
    </Card>
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
    <Card className="mt-4 flex-row items-center gap-2">
      <Text variant="muted" className="flex-1">
        {t(key)}
      </Text>
      <RepositoryRefreshButton onRefreshRepos={onRefreshRepos} isRetrying={isRetrying} />
    </Card>
  );
}
