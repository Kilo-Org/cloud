import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useQuery } from '@tanstack/react-query';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type TextInput, View, type ViewStyle } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Search, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowSkeleton } from '@/components/ui/row-skeleton';
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
const listContentContainerStyle = { flexGrow: 1 } satisfies ViewStyle;

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

function ProviderRow({
  provider,
  scope,
  last,
}: Readonly<{ provider: ProviderOption; scope: ProviderKeyScope; last: boolean }>) {
  const router = useRouter();

  return (
    <Pressable
      className={cn(
        ROW_TARGET_CLASS,
        'flex-row items-center gap-3 px-4 py-3 active:opacity-70',
        !last && 'border-b-[0.5px] border-hair-soft'
      )}
      accessibilityRole="button"
      accessibilityLabel={provider.name}
      onPress={() => {
        router.push(providerKeyNewHref(scope, provider.id));
      }}
    >
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {provider.name}
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
  const trpc = useTRPC();
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
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

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<ProviderOption>) => (
      <ProviderRow provider={item} scope={scope} last={index === filtered.length - 1} />
    ),
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
  } else {
    body = (
      <FlashList
        style={listStyle}
        data={filtered}
        keyExtractor={provider => provider.id}
        renderItem={renderItem}
        getItemType={() => 'provider'}
        {...SEARCHABLE_PICKER_LIST_PROPS}
        ListEmptyComponent={
          <EmptyState
            placement="top"
            icon={Search}
            title={t('profile.providerKeys.noProvidersTitle')}
            description={t('profile.providerKeys.noProvidersDescription')}
          />
        }
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('profile.providerKeys.chooseProvider')}
        backFallback={PROFILE_TAB_HREF}
      />
      <View className="flex-row items-center gap-2 px-4 pb-1 pt-2">
        <Search size={18} color={colors.mutedForeground} />
        <Input
          ref={inputRef}
          className="min-w-0 flex-1 border-0 bg-secondary"
          placeholder={t('profile.providerKeys.searchProviders')}
          accessibilityLabel={t('profile.providerKeys.searchProviders')}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onChangeText={setQuery}
        />
        {query === '' ? null : (
          <Button
            variant="ghost"
            size="icon"
            hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
            accessibilityLabel={t('common.clearSearch')}
            onPress={() => {
              setQuery('');
              inputRef.current?.clear();
            }}
          >
            <X size={16} color={colors.mutedForeground} />
          </Button>
        )}
      </View>
      {body}
    </View>
  );
}
