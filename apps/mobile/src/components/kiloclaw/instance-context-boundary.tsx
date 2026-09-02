import { type Href, useRouter } from 'expo-router';
import { SearchX } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type InstanceContextResult } from '@/lib/hooks/use-instance-context';

type Props = {
  title: string;
  context: InstanceContextResult;
};

export function InstanceContextBoundary({ title, context }: Readonly<Props>) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} />
      {context.status === 'error' ? (
        <QueryError
          message={t('kiloclaw.instance.couldNotLoad')}
          onRetry={() => {
            context.refetch();
          }}
        />
      ) : (
        <EmptyState
          icon={SearchX}
          title={t('kiloclaw.instance.notFound')}
          description={t('kiloclaw.instance.notFoundDescription')}
          action={
            <Button
              variant="outline"
              onPress={() => {
                router.replace('/(app)/(tabs)/(1_kiloclaw)' as Href);
              }}
            >
              <Text>{t('kiloclaw.instance.backToInstances')}</Text>
            </Button>
          }
        />
      )}
    </View>
  );
}
