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
  /** In-flight state of the retry the query-error body offers. */
  isRetrying?: boolean;
  /** The no-history body's next step (start a session). */
  createSessionAction?: ReactNode;
  onRetry: () => void;
  refreshControl?: ScrollViewProps['refreshControl'];
  /** Placement-memory identity for the list this body belongs to. */
  stateKey?: string;
};

export function BodyEmpty({
  kind,
  isSearching,
  secondaryAction,
  clearQueryAction,
  isRetrying,
  createSessionAction,
  onRetry,
  refreshControl,
  stateKey,
}: Readonly<BodyEmptyProps>) {
  const { t } = useTranslation();
  // One placement identity per body state. These states swap in place — clearing
  // a no-match search hands over to the no-past-sessions body — and a state that
  // painted from the previous one's remembered placement would show its first
  // frame at the other state's size and then shift.
  const placementKey = stateKey === undefined ? undefined : `${stateKey}:${kind}`;
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
        stateKey={placementKey}
      />
    );
  }
  if (kind === 'query-error-empty') {
    return (
      <CenteredState refreshControl={refreshControl} stateKey={placementKey}>
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
      action={createSessionAction}
      refreshControl={refreshControl}
      stateKey={placementKey}
    />
  );
}
