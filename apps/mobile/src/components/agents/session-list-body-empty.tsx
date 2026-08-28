import { History, SearchX } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';

type BodyEmptyProps = {
  kind: 'filtered-empty' | 'query-error-empty' | 'no-past-sessions';
  isSearching: boolean;
  secondaryAction?: 'clear-search' | 'clear-filters' | 'none';
  clearQueryAction: ReactNode;
  onRetry: () => void;
};

/**
 * Renders the body empty-state for the Agents session list, switched on the
 * `kind` returned by the body render model. Each branch is a compact
 * `View` matching the design language of the rest of the list (icon + title
 * + description). `no-past-sessions` carries no CTA: creation is offered by
 * the FAB/tray on the live screen.
 */
export function BodyEmpty({
  kind,
  isSearching,
  secondaryAction,
  clearQueryAction,
  onRetry,
}: Readonly<BodyEmptyProps>) {
  const { t } = useTranslation();
  if (kind === 'filtered-empty') {
    // Active search/filter narrowed the results to zero matches — never
    // show the "create a task" CTA here, it's not the fix for a filter
    // that's too narrow.
    return (
      <View className="items-center justify-center pt-16">
        <EmptyState
          icon={SearchX}
          title={t('agents.sessionList.noMatches')}
          description={
            isSearching
              ? t('agents.sessionList.tryDifferentSearch')
              : t('agents.sessionList.tryAdjustFilters')
          }
          action={clearQueryAction}
        />
      </View>
    );
  }
  if (kind === 'query-error-empty') {
    // The query in error produced no rows to show — surface a retry for
    // it (search or list, whichever `onRetry` targets). A Clear CTA is
    // shown whenever the model reports an active query, choosing the
    // label that matches the query type.
    return (
      <View className="items-center gap-4 pt-16">
        <QueryError
          placement="top"
          className="pt-0"
          message={
            isSearching
              ? t('agents.sessionList.couldNotSearch')
              : t('agents.sessionList.couldNotLoad')
          }
          onRetry={onRetry}
        />
        {secondaryAction === 'clear-search' || secondaryAction === 'clear-filters'
          ? clearQueryAction
          : null}
      </View>
    );
  }
  // 'no-past-sessions' — body is empty but the screen offers creation via
  // the FAB/tray, so no CTA is rendered here.
  return (
    <View className="items-center justify-center pt-12">
      <EmptyState
        icon={History}
        title={t('agents.sessionList.noPastSessions')}
        description={t('agents.sessionList.completedWillAppear')}
        placement="top"
      />
    </View>
  );
}
