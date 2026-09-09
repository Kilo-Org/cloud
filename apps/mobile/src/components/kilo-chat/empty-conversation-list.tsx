import { MessageSquarePlus } from '@/components/ui/icons';
import { type ScrollViewProps } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type Props = {
  onStart: () => void;
  isStarting: boolean;
  refreshControl?: ScrollViewProps['refreshControl'];
};

export function EmptyConversationList({ onStart, isStarting, refreshControl }: Props) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={MessageSquarePlus}
      title={t('chat.conversationList.emptyTitle')}
      description={t('chat.conversationList.emptyDescription')}
      refreshControl={refreshControl}
      action={
        <Button className="h-11 px-5" onPress={onStart} disabled={isStarting}>
          <Text>{isStarting ? t('common.starting') : t('chat.conversationList.create')}</Text>
        </Button>
      }
    />
  );
}
