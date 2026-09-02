import { Search, Terminal } from '@/components/ui/icons';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, TextInput, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionListSectionHeader } from '@/components/agents/session-list-section-header';
import { StoredSessionRow } from '@/components/agents/session-row';
import { CenteredState } from '@/components/centered-state';
import { DestinationOptionRow } from '@/components/destination-option-row';
import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { type ShareCliSpawnRow } from './share-cli-spawn';
import { type ShareDestinationRow } from './share-destinations';
import { type ShareGateState } from './share-gate-state';

const SEARCH_THRESHOLD = 8;
const SKELETON_COUNT = 5;

type ShareDestinationListProps = {
  headerContent?: ReactNode;
  state: ShareGateState;
  destinations: readonly ShareDestinationRow[];
  onSelect: (row: ShareDestinationRow) => void;
  onRetry: () => void;
  instances: readonly ShareCliSpawnRow[];
  spawningConnectionId: string | null;
  instanceRowsDisabled: boolean;
  destinationsDisabled: boolean;
  onSpawnInstance: (row: ShareCliSpawnRow) => void;
};

function DestinationSearch({ onChange }: { onChange: (next: string) => void }) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="mx-4 mb-3 mt-1 flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2">
      <Search size={18} color={colors.mutedForeground} />
      <TextInput
        placeholder={t('share.searchPlaceholder')}
        placeholderTextColor={colors.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        className="h-8 flex-1 p-0 text-base text-foreground"
        style={{ color: colors.foreground }}
        onChangeText={onChange}
        accessibilityLabel={t('share.searchPlaceholder')}
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

function CliInstanceRows({
  instances,
  spawningConnectionId,
  instanceRowsDisabled,
  onSpawnInstance,
}: {
  instances: readonly ShareCliSpawnRow[];
  spawningConnectionId: string | null;
  instanceRowsDisabled: boolean;
  onSpawnInstance: (row: ShareCliSpawnRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <View>
      <SessionListSectionHeader title={t('share.connectedCli')} count={instances.length} />
      {instances.map(row => (
        <DestinationOptionRow
          key={row.connectionId}
          icon={Terminal}
          title={row.name}
          subtitle={row.projectName}
          accessibilityLabel={t('share.newSessionOn', { name: row.name })}
          disabled={instanceRowsDisabled}
          busy={spawningConnectionId === row.connectionId}
          onPress={() => {
            onSpawnInstance(row);
          }}
        />
      ))}
    </View>
  );
}

export function ShareDestinationList({
  headerContent,
  state,
  destinations,
  onSelect,
  onRetry,
  instances,
  spawningConnectionId,
  instanceRowsDisabled,
  destinationsDisabled,
  onSpawnInstance,
}: Readonly<ShareDestinationListProps>) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const showSearch = state.kind === 'happy' && destinations.length > SEARCH_THRESHOLD;

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
  const noChoices = instances.length === 0;
  let body: ReactNode = null;

  if (state.kind === 'stale-share' || state.kind === 'non-retryable-classification') {
    body = (
      <CenteredState className="bg-background px-6">
        <Text className="text-center text-sm text-muted-foreground">{state.message}</Text>
      </CenteredState>
    );
  } else if (noChoices && state.kind === 'retryable') {
    body = <QueryError message={state.message} onRetry={onRetry} className="bg-background" />;
  } else if (
    noChoices &&
    (state.kind === 'empty' || (state.kind === 'happy' && filtered.length === 0))
  ) {
    body = (
      <CenteredState className="bg-background px-6">
        <Text className="text-center text-sm text-muted-foreground">
          {state.kind === 'empty' ? state.message : t('share.noMatchingSessions')}
        </Text>
      </CenteredState>
    );
  } else {
    let emptyContent: ReactNode = null;
    if (state.kind === 'loading') {
      emptyContent = <SkeletonRows />;
    } else if (state.kind === 'retryable') {
      emptyContent = <QueryError message={state.message} onRetry={onRetry} placement="top" />;
    } else if (state.kind === 'empty') {
      emptyContent = <EmptyMessage message={state.message} />;
    } else if (search.trim()) {
      emptyContent = <EmptyMessage message={t('share.noMatchingSessions')} />;
    }

    body = (
      <FlatList
        className="flex-1 bg-background"
        data={state.kind === 'happy' ? filtered : []}
        keyExtractor={item => item.session_id}
        ListHeaderComponent={
          instances.length > 0 ? (
            <CliInstanceRows
              instances={instances}
              spawningConnectionId={spawningConnectionId}
              instanceRowsDisabled={instanceRowsDisabled}
              onSpawnInstance={onSpawnInstance}
            />
          ) : null
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={contentPad}
        renderItem={({ item }) => (
          <View
            pointerEvents={destinationsDisabled ? 'none' : 'auto'}
            className={destinationsDisabled ? 'opacity-50' : undefined}
          >
            <StoredSessionRow
              session={item}
              sortBy="updated_at"
              live={item.live}
              metaWhileLive={item.live}
              interactive={false}
              onPress={() => {
                if (destinationsDisabled) {
                  return;
                }
                onSelect(item);
              }}
            />
          </View>
        )}
        ListEmptyComponent={emptyContent}
      />
    );
  }

  return (
    <>
      <View collapsable={false} className="bg-background">
        {headerContent}
        {showSearch ? <DestinationSearch onChange={setSearch} /> : null}
      </View>
      {body}
    </>
  );
}
