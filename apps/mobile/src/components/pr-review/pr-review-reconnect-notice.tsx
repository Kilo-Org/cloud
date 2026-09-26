import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useProviderPrScopeOrNull } from '@/lib/pr-review/provider-pr-ref';
import { useCheckGitHubConnection } from '@/lib/pr-review/use-check-github-connection';
import { useCheckProviderConnection } from '@/lib/pr-review/use-check-provider-connection';

/**
 * The mid-session recovery notice for an expired provider connection. The
 * surface that caught the precondition failure renders it; this component
 * decides WHICH connection to re-check from the provider scope the route
 * published — the GitHub route publishes none, so the GitHub arm (and the
 * original copy) is the fallback. A GitLab or Bitbucket surface re-checks
 * its own integration status instead, because a GitHub retry can never fix
 * an expired GitLab connection.
 */
export function PrReviewReconnectNotice() {
  const connection = useCheckGitHubConnection();
  const providerConnection = useCheckProviderConnection();
  const scope = useProviderPrScopeOrNull();
  const platform = scope?.ref.platform ?? 'github';
  const organizationId = scope?.organizationId ?? null;
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
