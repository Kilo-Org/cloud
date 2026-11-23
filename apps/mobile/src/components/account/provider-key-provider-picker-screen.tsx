import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useQuery } from '@tanstack/react-query';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View, type ViewStyle } from 'react-native';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Search } from '@/components/ui/icons';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { SearchField } from '@/components/ui/search-field';
import { Text } from '@/components/ui/text';
import { foldForSearch } from '@/i18n/fold-for-search';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import {
  providerKeyNewHref,
  type ProviderKeyScope,
  providerKeyScope,
  providerKeyScopeInput,
} from '@/lib/byok/provider-key-scope';
import { providerKeyName } from '@/lib/byok/provider-key-name';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

type ProviderOption = inferRouterOutputs<MobileRouter>['byok']['listProviders'][number];

/** Ids are ASCII slugs: folding them here keeps the comparison locale-independent. */
const ID_FOLD_LOCALE = 'en';

const listStyle = { flex: 1 } satisfies ViewStyle;

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

function ProviderRow({
  provider,
  scope,
  last,
}: Readonly<{ provider: ProviderOption; scope: ProviderKeyScope; last: boolean }>) {
  const router = useRouter();
  const name = providerKeyName(provider.id, provider.name);

  return (
    <Pressable
      className={cn(
        ROW_TARGET_CLASS,
        'flex-row items-center gap-3 px-4 py-3 active:opacity-70',
        !last && 'border-b-[0.5px] border-hair-soft'
      )}
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={() => {
        router.push(providerKeyNewHref(scope, provider.id));
      }}
    >
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {name}
      </Text>
      <RowChevron />
    </Pressable>
  );
}

/**
 * Which provider a new key belongs to.
 *
 * The list is the server's own, so the app offers exactly the providers the add
 * form accepts — including the ones an organization has to be enabled for, which
 * the server only lists where they are allowed. Choosing a provider opens the
 * key form with that provider fixed, because the two steps cannot share one
 * screen without the provider list pushing the field off a phone.
 */
export function ProviderKeyProviderPickerScreen({
  organizationId,
}: Readonly<{ organizationId?: string }>) {
  const { t, i18n } = useTranslation();
  const sideInsetStyle = useSideInsetStyle();
  const trpc = useTRPC();
  const listRef = useRef<FlashListRef<ProviderOption>>(null);
  const [query, setQuery] = useState('');
  const scope = providerKeyScope(organizationId);
  // A paused read would leave the picker empty with no request and no retry.
  const providers = useQuery({
    ...trpc.byok.listProviders.queryOptions(providerKeyScopeInput(scope)),
    ...SETTLE_WHILE_OFFLINE,
  });

  const filtered = useMemo(() => {
    const rows = providers.data ?? [];
    const trimmed = query.trim();
    if (trimmed === '') {
      return rows;
    }
    // The two columns fold differently on purpose. A display name is read in the
    // reader's language, so it folds in that locale. An id is an ASCII slug, so it
    // folds in a fixed one: a Turkish capital I becomes "ı" in the name needle and
    // would otherwise stop matching the `…-ai-…` id it used to.
    const nameNeedle = trimmed.toLocaleLowerCase(i18n.language);
    const idNeedle = trimmed.toLocaleLowerCase(ID_FOLD_LOCALE);
    // A display name is folded as well, so "cafe" finds "Café": the accented
    // spelling is what the row shows, and the typist may offer the plain letter.
    // A query that folds to nothing is all diacritics and keeps the raw
    // comparison alone, rather than matching every name.
    const foldedNeedle = foldForSearch(trimmed);
    return rows.filter(provider => {
      // The row shows the resolved name, so the search matches what the reader
      // sees; the server's English name keeps answering a query typed from it,
      // so switching the row to the catalog name does not break that habit.
      // Both names fold the same way, accents included.
      const names = [providerKeyName(provider.id, provider.name), provider.name];
      const matchesName = names.some(
        name =>
          name.toLocaleLowerCase(i18n.language).includes(nameNeedle) ||
          (foldedNeedle !== '' && foldForSearch(name).includes(foldedNeedle))
      );
      return matchesName || provider.id.toLocaleLowerCase(ID_FOLD_LOCALE).includes(idNeedle);
    });
  }, [providers.data, query, i18n.language]);

  // A query change draws a shorter list under the current offset, so a deep
  // scroll would leave the matching rows above the viewport (a cleared search
  // opened past the first provider). `repository-rows-list` carries the same
  // reset.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [query]);

  const renderItem = useCallback(
    ({ item, index }: { item: ProviderOption | undefined; index: number }) =>
      // A stale index past the end of the rows (the model picker's renderItem
      // carries the same guard for the same reason).
      item ? (
        <ProviderRow provider={item} scope={scope} last={index === filtered.length - 1} />
      ) : null,
    [scope, filtered.length]
  );

  let body: ReactNode = null;
  if (providers.isPending) {
    body = (
      <View>
        {SKELETON_ROWS.map(row => (
          <RowSkeleton key={row} />
        ))}
      </View>
    );
  } else if (providers.isError) {
    body = (
      <QueryError onRetry={() => void providers.refetch()} isRetrying={providers.isFetching} />
    );
  } else if (filtered.length === 0) {
    // The empty state replaces the list instead of riding in it as a
    // `ListEmptyComponent`: FlashList mis-lays-out the empty → populated
    // transition, and a list remounted with rows starts at the top, so a
    // cleared search shows the first provider (see `session-list-content`
    // for the same shape). The search field sits above the list, so the swap
    // cannot remount the input.
    body = (
      <EmptyState
        placement="top"
        inset="gutter"
        icon={Search}
        title={t('profile.providerKeys.noProvidersTitle')}
        description={t('profile.providerKeys.noProvidersDescription')}
      />
    );
  } else {
    body = (
      <FlashList<ProviderOption>
        ref={listRef}
        style={listStyle}
        data={filtered}
        keyExtractor={(provider: ProviderOption | undefined, index) =>
          provider?.id ?? String(index)
        }
        maintainVisibleContentPosition={{ disabled: true }}
        renderItem={renderItem}
        getItemType={() => 'provider'}
        {...SEARCHABLE_PICKER_LIST_PROPS}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('profile.providerKeys.chooseProvider')}
        backFallback={PROFILE_TAB_HREF}
      />
      <View className="flex-1" style={sideInsetStyle}>
        <View className={cn(SCREEN_GUTTER_CLASS, 'pb-1 pt-2')}>
          {/* The page gutter, not a hand-picked inset: the field's edges sit on
              the same 14pt line as the rows below it. */}
          <SearchField
            placeholder={t('profile.providerKeys.searchProviders')}
            hasText={query !== ''}
            onChangeText={setQuery}
          />
        </View>
        {body}
      </View>
    </View>
  );
}
