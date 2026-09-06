import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useCheckGitHubConnection } from '@/lib/pr-review/use-check-github-connection';

export function PrReviewReconnectNotice() {
  const connection = useCheckGitHubConnection();
  const { t } = useTranslation();

  return (
    <View className="gap-3 rounded-lg bg-secondary p-4">
      <Text className="text-sm font-medium text-foreground">
        {t('prReview.reconnectNotice.title')}
      </Text>
      <Text className="text-sm text-muted-foreground">{t('prReview.reconnectNotice.message')}</Text>
      <Button
        variant="outline"
        onPress={() => {
          connection.mutate();
        }}
        loading={connection.isPending}
        accessibilityLabel={t('prReview.checkConnection')}
      >
        <Text>{t('prReview.checkConnection')}</Text>
      </Button>
    </View>
  );
}
