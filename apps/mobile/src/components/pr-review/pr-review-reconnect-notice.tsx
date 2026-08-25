import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTRPC } from '@/lib/trpc';

/**
 * Shared reconnect affordance for PR Review surfaces. A
 * PRECONDITION_FAILED on a query or mutation means the gate's GitHub
 * authorization is no longer valid even though the gate passed. We
 * force a refetch of the gate's query so the wrapping
 * `PrReviewConnectGate` renders its own connect/reconnect CTA. The
 * caller owns section/tab framing; this component is just the
 * message + button.
 */
export function PrReviewReconnectNotice() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { t } = useTranslation();

  const handleReconnect = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.githubApps.getUserAuthorization.queryKey(),
    });
  };

  return (
    <View className="gap-3 rounded-lg bg-secondary p-4">
      <Text className="text-sm font-medium text-foreground">
        {t('prReview.reconnectNotice.title')}
      </Text>
      <Text className="text-sm text-muted-foreground">{t('prReview.reconnectNotice.message')}</Text>
      <Button
        variant="outline"
        onPress={handleReconnect}
        accessibilityLabel={t('prReview.reconnectNotice.checkConnection')}
      >
        <Text>{t('prReview.reconnectNotice.checkConnection')}</Text>
      </Button>
    </View>
  );
}
