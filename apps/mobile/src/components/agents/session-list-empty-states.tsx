import { Bot, Plus, SearchX } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Shown when the user has no sessions at all (first use). Split out of
 * `session-list-content.tsx` purely to keep that file under the repo's
 * max-lines limit; it has no state of its own.
 */
export function AgentSessionListEmptyState({
  onCreateSession,
}: Readonly<{ onCreateSession: () => void }>) {
  const colors = useThemeColors();
  return (
    <View className="flex-1 items-center justify-center">
      <EmptyState
        icon={Bot}
        title="No sessions yet"
        description="Start a coding task from your phone. Your sessions will appear here."
        action={
          <Button variant="outline" onPress={onCreateSession}>
            <Plus size={16} color={colors.foreground} />
            <Text>New coding task</Text>
          </Button>
        }
      />
    </View>
  );
}

/**
 * Shown when an active search or filter narrowed the results to zero
 * matches (`filtered`), or when the search/list query itself errored
 * while there were no cached rows to fall back on (`queryError`). Only
 * reachable when `hasAnySessions` is true — the true first-use empty
 * state is `AgentSessionListEmptyState` above.
 */
export function AgentSessionFilteredEmptyState({
  variant,
  isSearching,
  onClearQuery,
  onRetry,
}: Readonly<{
  variant: 'filtered' | 'queryError';
  isSearching: boolean;
  onClearQuery: () => void;
  onRetry: () => void;
}>) {
  const clearAction = (
    <Button variant="outline" onPress={onClearQuery}>
      <Text>{isSearching ? 'Clear search' : 'Clear filters'}</Text>
    </Button>
  );

  if (variant === 'queryError') {
    return (
      <View className="items-center gap-4 pt-16">
        <QueryError
          placement="top"
          className="pt-0"
          message={isSearching ? 'Could not search sessions' : 'Could not load sessions'}
          onRetry={onRetry}
        />
        {clearAction}
      </View>
    );
  }

  return (
    <View className="items-center justify-center pt-16">
      <EmptyState
        icon={SearchX}
        title="No sessions match"
        description={
          isSearching ? 'Try a different search term.' : 'Try adjusting or clearing your filters.'
        }
        action={clearAction}
      />
    </View>
  );
}
