import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { type ScrollViewProps } from 'react-native';

import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Bot, Plus } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type LiveSessionListEmptyStateProps = {
  organizationId: string | null;
  refreshControl?: ScrollViewProps['refreshControl'];
};

export function LiveSessionListEmptyState({
  organizationId,
  refreshControl,
}: Readonly<LiveSessionListEmptyStateProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <EmptyState
      refreshControl={refreshControl}
      icon={Bot}
      title={t('home.noLiveSessions')}
      description={t('agents.sessionList.noSessionsYetDescription')}
      action={
        <Button
          variant="outline"
          className="max-w-full"
          accessibilityLabel={t('common.newSession')}
          onPress={() => {
            router.push(getNewAgentSessionPath(organizationId) as Href);
          }}
        >
          <Plus size={16} color={colors.foreground} />
          <Text className="shrink text-center">{t('common.newSession')}</Text>
        </Button>
      }
    />
  );
}
