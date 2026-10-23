import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useProviderPrScopeOrNull } from '@/lib/pr-review/provider-pr-ref';
import { useCheckProviderConnection } from '@/lib/pr-review/use-check-provider-connection';

/**
 * Recovery actions for a provider PR/MR surface's terminal-looking
 * "unavailable" state. GitLab folds its connection failures (no integration,
 * inactive integration) into the same NOT_FOUND a deleted merge request
 * produces, and Bitbucket does the same for its workspace failures, so the
 * state cannot tell the two apart. A retry re-runs the read; the connection
 * check re-reads the integration status and, when connected, invalidates
 * `providerReview` so every surface below it refetches.
 *
 * Renders nothing on a GitHub scope: GitHub's not-found has its own install
 * CTA and its connectivity is the GitHub App authorization, not an
 * integration status this hook can check.
 */
export function PrReviewUnavailableActions({
  onRetry,
  isRetrying,
}: Readonly<{
  onRetry: () => void;
  isRetrying: boolean;
}>) {
  const { t } = useTranslation();
  const scope = useProviderPrScopeOrNull();
  const providerConnection = useCheckProviderConnection();
  const providerPlatform =
    scope === null || scope.ref.platform === 'github' ? null : scope.ref.platform;

  if (!providerPlatform) {
    return null;
  }

  return (
    <View className="mt-3 w-full gap-2">
      <Button variant="outline" onPress={onRetry} loading={isRetrying}>
        <Text>{t('common.retry')}</Text>
      </Button>
      <Button
        variant="outline"
        onPress={() => {
          providerConnection.mutate({
            platform: providerPlatform,
            organizationId: scope?.organizationId ?? null,
          });
        }}
        loading={providerConnection.isPending}
        accessibilityLabel={t('prReview.checkConnection')}
      >
        <Text>{t('prReview.checkConnection')}</Text>
      </Button>
    </View>
  );
}
