import { FlashList, type FlashListRef } from '@shopify/flash-list';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, type ScrollViewProps, View, type ViewStyle } from 'react-native';

import { RepositorySearchField } from '@/components/code-reviewer/repository-search-field';
import { EmptyState } from '@/components/empty-state';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { SearchX } from '@/components/ui/icons';
import { SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';
import { filterRepoPickerOptions } from '@/lib/repo-picker-filter';

/** A repository as the three providers' cached snapshots describe it. */
export type RepositoryRow = { id: number | string; fullName: string; private?: boolean };

// `FlashList` takes styles, not classes: the content inset the scroll body used
// to carry as `px-6 pt-4`, in pixels, and a list that fills its frame.
const LIST_STYLE = { flex: 1 } satisfies ViewStyle;
const LIST_CONTENT_STYLE = { paddingHorizontal: 24, paddingTop: 16 } satisfies ViewStyle;

function repositoryKey(repository: RepositoryRow): string {
  return String(repository.id);
}

/**
 * The rows of a reviewer repository picker: a virtualized list, so a snapshot of
 * several hundred repositories mounts only the rows on screen, with the field
 * that narrows them above them.
 *
 * The screen keeps what frames the rows (the mode choice, the all-mode summary,
 * the states that replace the body, and the sync footer) and passes it in as
 * slots; this owns only what belongs to the rows: the query, the filtered data,
 * the empty result state and the list's own scroll position.
 */
export function RepositoryRowsList({
  repositories,
  selectedIds,
  disabled,
  onToggle,
  searchable,
  header,
  headerGapClass,
  footer,
  refreshControl,
  style,
  onLayout,
}: Readonly<{
  repositories: RepositoryRow[];
  selectedIds: readonly (number | string)[];
  disabled: boolean;
  onToggle: (id: number | string) => void;
  /** The field only arrives with rows it can narrow. */
  searchable: boolean;
  header: ReactNode;
  /** The section gap the rows keep under the header. */
  headerGapClass: string;
  footer?: ReactElement;
  refreshControl?: ScrollViewProps['refreshControl'];
  /** The tab screen frame: the reserved band and the side insets. */
  style: ViewStyle;
  onLayout: (event: LayoutChangeEvent) => void;
}>) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  // The field stays urgent; the filtered rows trail behind so a typing burst on
  // a several-hundred-row snapshot does not re-filter on every key.
  const deferredSearch = useDeferredValue(search);
  const visibleRows = useMemo(
    () => filterRepoPickerOptions({ repositories, search: deferredSearch }),
    [repositories, deferredSearch]
  );
  const listRef = useRef<FlashListRef<RepositoryRow>>(null);
  // The field exists only while the snapshot has rows to narrow, so a query
  // cannot outlive it: a mode switch unmounts the field, and the list would
  // otherwise come back filtered by text the reader can no longer see.
  useEffect(() => {
    if (!searchable) {
      setSearch('');
    }
  }, [searchable]);
  // A query change draws a shorter list under the current offset, so a deep
  // scroll would leave a blank viewport behind the rows that remain.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [deferredSearch]);

  const renderRow = useCallback(
    ({ item }: { item: RepositoryRow | undefined }) => {
      // FlashList can ask for an index past the end of a shorter rows array
      // React discarded with a deferred render; the row is then undefined. The
      // model picker carries the same guard for the same reason.
      if (!item) {
        return null;
      }
      return (
        <RepoToggleRow
          repo={item}
          selected={selectedIds.includes(item.id)}
          disabled={disabled}
          className="border-b-[0.5px] border-hair-soft"
          onPress={() => {
            onToggle(item.id);
          }}
        />
      );
    },
    [selectedIds, disabled, onToggle]
  );

  // A query that matches none of the snapshot's rows emptied the body; the
  // snapshot's own empty and failed states stay in the header the screen owns.
  const noMatchState =
    searchable && deferredSearch.trim() !== '' && visibleRows.length === 0 ? (
      <EmptyState
        placement="top"
        icon={SearchX}
        title={t('agentChat.repoPicker.noMatches')}
        description={t('agents.sessionList.tryDifferentSearch')}
      />
    ) : null;

  return (
    <View className="flex-1" style={style} onLayout={onLayout}>
      <FlashList<RepositoryRow>
        ref={listRef}
        style={LIST_STYLE}
        data={visibleRows}
        keyExtractor={(item: RepositoryRow | undefined, index) =>
          item ? repositoryKey(item) : String(index)
        }
        renderItem={renderRow}
        contentContainerStyle={LIST_CONTENT_STYLE}
        ListHeaderComponent={
          <View className={headerGapClass}>
            {header}
            {searchable && <RepositorySearchField onChangeText={setSearch} />}
          </View>
        }
        ListEmptyComponent={noMatchState}
        ListFooterComponent={footer}
        refreshControl={refreshControl}
        {...SEARCHABLE_PICKER_LIST_PROPS}
      />
    </View>
  );
}
