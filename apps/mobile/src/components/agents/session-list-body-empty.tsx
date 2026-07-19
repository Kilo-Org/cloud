import { History, SearchX } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';

type BodyEmptyProps = {
  kind: 'filtered-empty' | 'query-error-empty' | 'no-past-sessions';
  isSearching: boolean;
  secondaryAction?: 'clear-search' | 'clear-filters' | 'none';
  emptyStateAction: ReactNode;
  clearQueryAction: ReactNode;
  onRetry: () => void;
};

/**
 * Renders the body empty-state for the Agents session list, switched on the
 * `kind` returned by the body render model. Each branch is a compact
 * `View` matching the design language of the rest of the list (icon + title
 * + description + one CTA).
 */
export function BodyEmpty({
  kind,
  isSearching,
  secondaryAction,
  emptyStateAction,
  clearQueryAction,
  onRetry,
}: Readonly<BodyEmptyProps>) {
  if (kind === 'filtered-empty') {
    // Active search/filter narrowed the results to zero matches — never
    // show the "create a task" CTA here, it's not the fix for a filter
    // that's too narrow.
    return (
      <View className="items-center justify-center pt-16">
        <EmptyState
          icon={SearchX}
          title="No sessions match"
          description={
            isSearching ? 'Try a different search term.' : 'Try adjusting or clearing your filters.'
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
          message={isSearching ? 'Could not search sessions' : 'Could not load sessions'}
          onRetry={onRetry}
        />
        {secondaryAction === 'clear-search' || secondaryAction === 'clear-filters'
          ? clearQueryAction
          : null}
      </View>
    );
  }
  // 'no-past-sessions' — body is empty but the tray is populated. The
  // screen-level first-use empty ("No sessions yet") is handled by the
  // caller when there is no tray either.
  return (
    <View className="items-center justify-center pt-12">
      <EmptyState
        icon={History}
        title="No past sessions"
        description="Completed sessions will appear here."
        action={emptyStateAction}
        placement="top"
      />
    </View>
  );
}
