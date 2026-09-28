import { type Href, useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type ScrollViewProps, View } from 'react-native';

import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Bot, Plus } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type LiveSessionListEmptyStateProps = {
  organizationId: string | null;
  refreshControl?: ScrollViewProps['refreshControl'];
  /** Short presentation for a clear region that cannot hold the full state. */
  compact?: boolean;
  /** Secondary action under the primary one, e.g. the route to stored history. */
  historyAction?: ReactNode;
};

export function LiveSessionListEmptyState({
  organizationId,
  refreshControl,
  compact = false,
  historyAction,
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
      compact={compact}
      action={
        <View className="items-center gap-3">
          <Button
            variant="default"
            size={compact ? 'sm' : 'default'}
            className="max-w-full"
            accessibilityLabel={t('common.newSession')}
            onPress={() => {
              router.push(getNewAgentSessionPath(organizationId) as Href);
            }}
          >
            <Plus size={16} color={colors.primaryForeground} />
            <Text className="shrink text-center">{t('common.newSession')}</Text>
          </Button>
          {historyAction}
        </View>
      }
    />
  );
}
