import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useQuery } from '@tanstack/react-query';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type TextInput, View, type ViewStyle } from 'react-native';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Search, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_HIT_SLOP_DP, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';
import {
  providerKeyNewHref,
  type ProviderKeyScope,
  providerKeyScope,
  providerKeyScopeInput,
} from '@/lib/byok/provider-key-scope';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

type ProviderOption = inferRouterOutputs<MobileRouter>['byok']['listProviders'][number];

/** Ids are ASCII slugs: folding them here keeps the comparison locale-independent. */
const ID_FOLD_LOCALE = 'en';

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  flexGrow: 1,
  paddingHorizontal: 16,
  paddingTop: 12,
} satisfies ViewStyle;

const PROVIDER_ROW_SEPARATOR = () => <View className="h-px bg-border" />;
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

function ProviderRow({
  provider,
  scope,
}: Readonly<{ provider: ProviderOption; scope: ProviderKeyScope }>) {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <Pressable
      className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-3 py-3 active:opacity-70')}
      accessibilityRole="button"
      accessibilityLabel={provider.name}
      onPress={() => {
        router.push(providerKeyNewHref(scope, provider.id));
      }}
    >
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {provider.name}
      </Text>
      <DirectionalChevronRight size={14} color={colors.mutedForeground} />
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
  const trpc = useTRPC();
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlashListRef<ProviderOption>>(null);
  const [query, setQuery] = useState('');
  const scope = providerKeyScope(organizationId);
  const providers = useQuery(trpc.byok.listProviders.queryOptions(providerKeyScopeInput(scope)));

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
    return rows.filter(
      provider =>
        provider.name.toLocaleLowerCase(i18n.language).includes(nameNeedle) ||
        provider.id.toLocaleLowerCase(ID_FOLD_LOCALE).includes(idNeedle)
    );
  }, [providers.data, query, i18n.language]);

  // A query change draws a shorter list under the current offset, so a deep
  // scroll would leave the matching rows above the viewport (a cleared search
  // opened past the first provider). `repository-rows-list` carries the same
  // reset.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [query]);

  const renderItem = useCallback(
    ({ item }: { item: ProviderOption | undefined }) =>
      // A stale index past the end of the rows (the model picker's renderItem
      // carries the same guard for the same reason).
      item ? <ProviderRow provider={item} scope={scope} /> : null,
    [scope]
  );

  let body: ReactNode = null;
  if (providers.isPending) {
    body = (
      <View className="gap-2 px-4 pt-3">
        {SKELETON_ROWS.map(row => (
          <Skeleton key={row} className="h-11 rounded-lg" />
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
        ItemSeparatorComponent={PROVIDER_ROW_SEPARATOR}
        contentContainerStyle={listContentContainerStyle}
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
      <View className="pb-1 pt-2 px-[16px]">
        {/* px-[16px], not px-4: the app's inlineRem is 14, so px-4 is 14 and the
            list rows' `paddingHorizontal: 16` would leave this box 2 wider on
            each side than the rows it sits above. */}
        <View className="min-h-[44px] flex-row items-center gap-2 rounded-lg bg-secondary px-3">
          <Search size={18} color={colors.mutedForeground} />
          <Input
            ref={inputRef}
            // The row owns the inset on both sides, so the field itself adds
            // none: a physical inset here pushed the field past its box in
            // right-to-left layouts, where the row's children swap sides.
            className="min-w-0 flex-1 pl-0 pr-0"
            placeholder={t('profile.providerKeys.searchProviders')}
            accessibilityLabel={t('profile.providerKeys.searchProviders')}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onChangeText={setQuery}
          />
          {query === '' ? null : (
            <Pressable
              hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
              accessibilityRole="button"
              accessibilityLabel={t('common.clearSearch')}
              className="h-[38px] w-[38px] items-center justify-center active:opacity-70"
              onPress={() => {
                setQuery('');
                inputRef.current?.clear();
              }}
            >
              <X size={16} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>
      </View>
      {body}
    </View>
  );
}
