import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type ProviderPrPlatform, useProviderPrScopeOrNull } from '@/lib/pr-review/provider-pr-ref';
import { useCheckGitHubConnection } from '@/lib/pr-review/use-check-github-connection';
import { useCheckProviderConnection } from '@/lib/pr-review/use-check-provider-connection';

/**
 * The mid-session recovery notice for an expired provider connection. The
 * surface that caught the precondition failure renders it; this component
 * decides WHICH connection to re-check. A detail route publishes its provider
 * scope and this reads it — the GitHub route publishes none, so the GitHub arm
 * (and the original copy) is that fallback. A provider-neutral surface (the
 * merged inbox) has no route scope at all, so it passes the failing provider
 * and its organization explicitly. A GitLab or Bitbucket arm re-checks its own
 * integration status, because a GitHub retry can never fix an expired GitLab
 * connection.
 */
type PrReviewReconnectNoticeProps = {
  /**
   * The provider whose connection failed. Omitted on surfaces that publish a
   * route provider scope (the detail routes); the provider-neutral inbox has
   * no route scope, so it names the failing provider explicitly.
   */
  platform?: ProviderPrPlatform;
  /** The organization scope of that provider; null means the personal scope. */
  organizationId?: string | null;
};

export function PrReviewReconnectNotice({
  platform: explicitPlatform,
  organizationId: explicitOrganizationId,
}: Readonly<PrReviewReconnectNoticeProps> = {}) {
  const connection = useCheckGitHubConnection();
  const providerConnection = useCheckProviderConnection();
  const scope = useProviderPrScopeOrNull();
  const platform = explicitPlatform ?? scope?.ref.platform ?? 'github';
  const organizationId =
    explicitOrganizationId !== undefined ? explicitOrganizationId : (scope?.organizationId ?? null);
  const providerPlatform = platform === 'github' ? null : platform;
  const { t } = useTranslation();

  let title = t('prReview.reconnectNotice.title');
  if (platform === 'gitlab') {
    title = t('prReview.reconnectNotice.gitlabTitle');
  } else if (platform === 'bitbucket') {
    title = t('prReview.reconnectNotice.bitbucketTitle');
  }
  const message =
    providerPlatform === null
      ? t('prReview.reconnectNotice.message')
      : t('prReview.reconnectNotice.providerMessage', {
          provider:
            platform === 'gitlab'
              ? t('common.gitlab')
              : t('agentChat.repoPicker.platformBitbucket'),
        });

  return (
    <View className="gap-3 rounded-lg bg-secondary p-4">
      <Text className="text-sm font-medium text-foreground">{title}</Text>
      <Text className="text-sm text-muted-foreground">{message}</Text>
      <Button
        variant="outline"
        onPress={() => {
          if (providerPlatform) {
            providerConnection.mutate({ platform: providerPlatform, organizationId });
            return;
          }
          connection.mutate();
        }}
        loading={providerPlatform ? providerConnection.isPending : connection.isPending}
        accessibilityLabel={t('prReview.checkConnection')}
      >
        <Text>{t('prReview.checkConnection')}</Text>
      </Button>
    </View>
  );
}
