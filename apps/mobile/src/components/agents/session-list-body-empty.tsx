import { History, SearchX } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { type ScrollViewProps, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';

type BodyEmptyProps = {
  kind: 'filtered-empty' | 'query-error-empty' | 'no-past-sessions';
  isSearching: boolean;
  secondaryAction?: 'clear-search' | 'clear-filters' | 'none';
  clearQueryAction: ReactNode;
  onRetry: () => void;
  refreshControl?: ScrollViewProps['refreshControl'];
};

export function BodyEmpty({
  kind,
  isSearching,
  secondaryAction,
  clearQueryAction,
  onRetry,
  refreshControl,
}: Readonly<BodyEmptyProps>) {
  const { t } = useTranslation();
  if (kind === 'filtered-empty') {
    return (
      <EmptyState
        icon={SearchX}
        title={t('agents.sessionList.noMatches')}
        description={
          isSearching
            ? t('agents.sessionList.tryDifferentSearch')
            : t('agents.sessionList.tryAdjustFilters')
        }
        action={clearQueryAction}
        refreshControl={refreshControl}
      />
    );
  }
  if (kind === 'query-error-empty') {
    return (
      <CenteredState refreshControl={refreshControl}>
        <View className="items-center gap-4">
          <QueryError
            placement="top"
            className="pt-0"
            message={
              isSearching
                ? t('agents.sessionList.couldNotSearch')
                : t('common.couldNotLoadSessions')
            }
            onRetry={onRetry}
          />
          {secondaryAction === 'clear-search' || secondaryAction === 'clear-filters'
            ? clearQueryAction
            : null}
        </View>
      </CenteredState>
    );
  }
  return (
    <EmptyState
      icon={History}
      title={t('agents.sessionList.noPastSessions')}
      description={t('agents.sessionList.completedWillAppear')}
      refreshControl={refreshControl}
    />
  );
}
