import { MessageSquarePlus } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type Props = {
  onStart: () => void;
  isStarting: boolean;
};

export function EmptyConversationList({ onStart, isStarting }: Props) {
  const { t } = useTranslation();
  return (
    <View className="min-h-[420px] flex-1 items-center justify-center px-6">
      <EmptyState
        icon={MessageSquarePlus}
        title={t('chat.conversationList.emptyTitle')}
        description={t('chat.conversationList.emptyDescription')}
        action={
          <Button className="h-11 px-5" onPress={onStart} disabled={isStarting}>
            <Text>
              {isStarting ? t('chat.conversationList.starting') : t('chat.conversationList.create')}
            </Text>
          </Button>
        }
      />
    </View>
  );
}
