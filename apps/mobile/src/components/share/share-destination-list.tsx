import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { Share2, Terminal } from '@/components/ui/icons';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionListSectionHeader } from '@/components/agents/session-list-section-header';
import { StoredSessionRow } from '@/components/agents/session-row';
import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { SearchField } from '@/components/ui/search-field';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { foldForSearch } from '@/i18n/fold-for-search';
import { formatNumber } from '@/lib/format';
import { sessionBranchLabel } from '@/lib/session-branch-label';
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

function SkeletonRows() {
  return (
    <View>
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <RowSkeleton key={i} variant="session" subtitle last={i === SKELETON_COUNT - 1} />
      ))}
    </View>
  );
}

function EmptyMessage({ message }: { message: string }) {
  return (
    <View className="items-center px-4 pt-3">
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
  const colors = useThemeColors();
  return (
    <View>
      <SessionListSectionHeader
        title={t('share.connectedCli')}
        count={instances.length}
        accessibilityLabel={t('share.connectedCliAccessibility', {
          title: t('share.connectedCli'),
          count: instances.length,
          displayCount: formatNumber(instances.length, i18n.language),
        })}
      />
      <View className="px-4 pt-3">
        <RowGroup leadingTile>
          {instances.map(row => (
            <ConfigureRow
              key={row.connectionId}
              icon={Terminal}
              title={row.name}
              subtitle={row.projectName}
              variant="action"
              disabled={instanceRowsDisabled}
              accessibilityLabel={t('share.newSessionOn', { name: row.name })}
              trailing={
                spawningConnectionId === row.connectionId ? (
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                ) : undefined
              }
              onPress={() => {
                onSpawnInstance(row);
              }}
            />
          ))}
        </RowGroup>
      </View>
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
  const colors = useThemeColors();
  const [search, setSearch] = useState('');
  const showSearch = state.kind === 'happy' && destinations.length > SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const q = foldForSearch(search.trim());
    if (q === '') {
      return destinations;
    }
    return destinations.filter(row => {
      // Every compared value folds case and diacritics, the same as the query,
      // so an unaccented query finds `Revisão do fluxo` and an accented query
      // still matches an accented branch: folding is a superset of the plain
      // lowercase comparison, so no match it found is lost.
      //
      // The branch appears twice on purpose: both the stored (percent-encoded)
      // branch and the decoded branch the row paints, so a person finds the
      // destination by typing either form.
      const title = foldForSearch(row.title ?? '');
      const branch = foldForSearch(row.git_branch ?? '');
      const paintedBranch = foldForSearch(sessionBranchLabel(row.git_branch) ?? '');
      return title.includes(q) || branch.includes(q) || paintedBranch.includes(q);
    });
  }, [destinations, search]);

  const contentPad = useMemo(() => ({ paddingBottom: bottom + 16 }) satisfies ViewStyle, [bottom]);
  // The list carries the sheet background itself: react-native-screens honors
  // the formSheet header only when [header, scroll view] are the content's
  // direct children, so no wrapping View may sit between them.
  const listStyle = useMemo(
    () => ({ flex: 1, backgroundColor: colors.background }) satisfies ViewStyle,
    [colors.background]
  );
  // Hoisted so a parent re-render (the share gate animates while this list is
  // mounted) does not hand every mounted row a new prop identity.
  const renderDestination = useCallback(
    ({ item }: ListRenderItemInfo<ShareDestinationRow>) => (
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
    ),
    [destinationsDisabled, onSelect]
  );
  const keyExtractor = useCallback((item: ShareDestinationRow) => item.session_id, []);
  const getItemType = useCallback(() => 'destination', []);
  const noChoices = instances.length === 0;
  let body: ReactNode = null;

  if (state.kind === 'stale-share') {
    // The sheet's header already closes it, so the state repeats no Close
    // action of its own.
    body = (
      <EmptyState
        className="bg-background"
        icon={Share2}
        title={t('share.staleTitle')}
        description={state.message}
      />
    );
  } else if (state.kind === 'non-retryable-classification') {
    body = (
      <CenteredState className="bg-background" contentContainerClassName="px-4">
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
      <CenteredState className="bg-background" contentContainerClassName="px-4">
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
      emptyContent = (
        <QueryError message={state.message} onRetry={onRetry} placement="top" inset="gutter" />
      );
    } else if (state.kind === 'empty') {
      emptyContent = <EmptyMessage message={state.message} />;
    } else if (search.trim()) {
      emptyContent = <EmptyMessage message={t('share.noMatchingSessions')} />;
    }

    body = (
      <FlashList<ShareDestinationRow>
        nestedScrollEnabled
        style={listStyle}
        data={state.kind === 'happy' ? filtered : []}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
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
        renderItem={renderDestination}
        ListEmptyComponent={emptyContent}
      />
    );
  }

  return (
    <>
      <View collapsable={false} className="bg-background">
        {headerContent}
        {showSearch ? (
          <SearchField
            className="mx-4 mb-3 mt-1"
            placeholder={t('share.searchPlaceholder')}
            hasText={search !== ''}
            onChangeText={setSearch}
          />
        ) : null}
      </View>
      {body}
    </>
  );
}
