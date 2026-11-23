import { useTranslation } from 'react-i18next';
import { type ScrollViewProps } from 'react-native';

import { useNewSessionNavigator } from '@/components/agents/use-new-session-navigator';
import { EmptyState, StateAction } from '@/components/empty-state';
import { Bot, Plus } from '@/components/ui/icons';

type LiveSessionListEmptyStateProps = {
  organizationId: string | null;
  refreshControl?: ScrollViewProps['refreshControl'];
  /** Short presentation for a clear region that cannot hold the full state. */
  compact?: boolean;
};

export function LiveSessionListEmptyState({
  organizationId,
  refreshControl,
  compact = false,
}: Readonly<LiveSessionListEmptyStateProps>) {
  const { openNewSession } = useNewSessionNavigator();
  const { t } = useTranslation();
  return (
    <EmptyState
      refreshControl={refreshControl}
      icon={Bot}
      title={t('home.noLiveSessions')}
      description={t('agents.sessionList.noSessionsYetDescription')}
      compact={compact}
      action={
        <StateAction
          label={t('common.newSession')}
          icon={Plus}
          onPress={() => {
            openNewSession(organizationId);
          }}
        />
      }
    />
  );
}
