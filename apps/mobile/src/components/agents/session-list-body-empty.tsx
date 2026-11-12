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
  /** A platform or project filter narrows the list, so it can cause the empty body. */
  hasActiveFilters: boolean;
  /** One control per active narrowing input; each clears only what its label names. */
  clearActions?: ReactNode;
  /** In-flight state of the retry the query-error body offers. */
  isRetrying?: boolean;
  /** The no-history body's next step (start a session). */
  createSessionAction?: ReactNode;
  onRetry: () => void;
  refreshControl?: ScrollViewProps['refreshControl'];
};

export function BodyEmpty({
  kind,
  isSearching,
  hasActiveFilters,
  clearActions,
  isRetrying,
  createSessionAction,
  onRetry,
  refreshControl,
}: Readonly<BodyEmptyProps>) {
  const { t } = useTranslation();
  if (kind === 'filtered-empty') {
    // The search field and the filter badge stay visible above this body, so
    // naming every cause keeps the copy honest: a filter alone can hide the
    // session, and the row below offers one action per cause.
    let description = t('agents.sessionList.tryAdjustFilters');
    if (isSearching && hasActiveFilters) {
      description = `${t('agents.sessionList.tryDifferentSearch')} ${description}`;
    } else if (isSearching) {
      description = t('agents.sessionList.tryDifferentSearch');
    }
    return (
      <EmptyState
        icon={SearchX}
        title={t('agents.sessionList.noMatches')}
        description={description}
        action={clearActions}
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
            isRetrying={isRetrying}
          />
          {clearActions}
        </View>
      </CenteredState>
    );
  }
  return (
    <EmptyState
      icon={History}
      title={t('agents.sessionList.noPastSessions')}
      description={t('agents.sessionList.completedWillAppear')}
      action={createSessionAction}
      refreshControl={refreshControl}
    />
  );
}
