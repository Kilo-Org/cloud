import { Search } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, TextInput, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StoredSessionRow } from '@/components/agents/session-row';
import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { type ShareDestinationRow } from './share-destinations';
import { type ShareGateState } from './share-gate-state';

const SEARCH_THRESHOLD = 8;
const SKELETON_COUNT = 5;

type ShareDestinationListProps = {
  state: ShareGateState;
  destinations: readonly ShareDestinationRow[];
  onSelect: (row: ShareDestinationRow) => void;
  onRetry: () => void;
};

function DestinationSearch({ onChange }: { onChange: (next: string) => void }) {
  const colors = useThemeColors();
  return (
    <View className="mx-4 mb-3 mt-1 flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2">
      <Search size={18} color={colors.mutedForeground} />
      <TextInput
        placeholder="Search recent sessions"
        placeholderTextColor={colors.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        className="h-8 flex-1 p-0 text-base text-foreground"
        style={{ color: colors.foreground }}
        onChangeText={onChange}
        accessibilityLabel="Search recent sessions"
      />
    </View>
  );
}

function SkeletonRows() {
  return (
    <View>
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <View key={i} className="py-1.5">
          <Skeleton className="mx-[22px] h-[76px] rounded-none" />
        </View>
      ))}
    </View>
  );
}

function EmptyMessage({ message }: { message: string }) {
  return (
    <View className="items-center px-6 pt-8">
      <Text className="text-center text-sm text-muted-foreground">{message}</Text>
    </View>
  );
}

/**
 * Destination FlatList for the share gate. Must be a direct child of the
 * formSheet screen content (paired with the collapsable header View).
 * Search is ListHeaderComponent — scrolls with the list, shown only when
 * loaded destination count > 8.
 */
export function ShareDestinationList({
  state,
  destinations,
  onSelect,
  onRetry,
}: Readonly<ShareDestinationListProps>) {
  const { bottom } = useSafeAreaInsets();
  const [search, setSearch] = useState('');

  const showSearch = destinations.length > SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === '') {
      return destinations;
    }
    return destinations.filter(row => {
      const title = (row.title ?? '').toLowerCase();
      const branch = (row.git_branch ?? '').toLowerCase();
      return title.includes(q) || branch.includes(q);
    });
  }, [destinations, search]);

  const contentPad = useMemo(() => ({ paddingBottom: bottom + 16 }) satisfies ViewStyle, [bottom]);
  const growContentPad = useMemo(
    () => ({ paddingBottom: bottom + 16, flexGrow: 1 }) satisfies ViewStyle,
    [bottom]
  );

  if (state.kind === 'loading') {
    return (
      <FlatList
        className="flex-1 bg-background"
        data={[] as ShareDestinationRow[]}
        keyExtractor={(_, index) => `skeleton-${index}`}
        ListHeaderComponent={<SkeletonRows />}
        renderItem={() => null}
        contentContainerStyle={contentPad}
        keyboardShouldPersistTaps="handled"
      />
    );
  }

  if (state.kind === 'retryable') {
    return (
      <FlatList
        className="flex-1 bg-background"
        data={[] as ShareDestinationRow[]}
        keyExtractor={() => 'error'}
        ListEmptyComponent={
          <QueryError message={state.message} onRetry={onRetry} placement="top" />
        }
        renderItem={() => null}
        contentContainerStyle={growContentPad}
        keyboardShouldPersistTaps="handled"
      />
    );
  }

  if (state.kind === 'empty') {
    return (
      <FlatList
        className="flex-1 bg-background"
        data={[] as ShareDestinationRow[]}
        keyExtractor={() => 'empty'}
        ListEmptyComponent={<EmptyMessage message={state.message} />}
        renderItem={() => null}
        contentContainerStyle={growContentPad}
        keyboardShouldPersistTaps="handled"
      />
    );
  }

  // Terminal non-retryable states: header already shows the message; keep an
  // empty FlatList so the formSheet still has [header, list] as direct children.
  if (state.kind === 'stale-share' || state.kind === 'non-retryable-classification') {
    return (
      <FlatList
        className="flex-1 bg-background"
        data={[] as ShareDestinationRow[]}
        keyExtractor={() => 'terminal'}
        renderItem={() => null}
        contentContainerStyle={contentPad}
        keyboardShouldPersistTaps="handled"
      />
    );
  }

  // happy
  return (
    <FlatList
      className="flex-1 bg-background"
      data={filtered as ShareDestinationRow[]}
      keyExtractor={item => item.session_id}
      ListHeaderComponent={showSearch ? <DestinationSearch onChange={setSearch} /> : null}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={contentPad}
      renderItem={({ item }) => (
        <StoredSessionRow
          session={item}
          sortBy="updated_at"
          live={item.live}
          metaWhileLive={item.live}
          interactive={false}
          onPress={() => {
            onSelect(item);
          }}
        />
      )}
      ListEmptyComponent={search.trim() ? <EmptyMessage message="No matching sessions." /> : null}
    />
  );
}
