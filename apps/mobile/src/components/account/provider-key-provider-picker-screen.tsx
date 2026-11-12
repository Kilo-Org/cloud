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
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Search, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_HIT_SLOP_DP, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

type ProviderOption = inferRouterOutputs<MobileRouter>['byok']['listProviders'][number];

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  flexGrow: 1,
  paddingHorizontal: 16,
  paddingTop: 12,
} satisfies ViewStyle;

const PROVIDER_ROW_SEPARATOR = () => <View className="h-px bg-border" />;
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

function ProviderRow({ provider }: Readonly<{ provider: ProviderOption }>) {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <Pressable
      className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-3 py-3 active:opacity-70')}
      accessibilityRole="button"
      accessibilityLabel={provider.name}
      onPress={() => {
        router.push({
          pathname: '/(app)/(tabs)/(3_profile)/provider-key-new',
          params: { provider: provider.id },
        });
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
export function ProviderKeyProviderPickerScreen() {
  const { t, i18n } = useTranslation();
  const trpc = useTRPC();
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const providers = useQuery(trpc.byok.listProviders.queryOptions({}));

  const filtered = useMemo(() => {
    const rows = providers.data ?? [];
    // Fold in the reader's language: Turkish has no bare i, so a lowercased
    // search term must be built with the same locale the names are read in.
    const needle = query.trim().toLocaleLowerCase(i18n.language);
    if (needle === '') {
      return rows;
    }
    return rows.filter(
      provider =>
        provider.name.toLocaleLowerCase(i18n.language).includes(needle) ||
        provider.id.includes(needle)
    );
  }, [providers.data, query, i18n.language]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ProviderOption>) => <ProviderRow provider={item} />,
    []
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
  } else {
    body = (
      <FlashList
        style={listStyle}
        data={filtered}
        keyExtractor={provider => provider.id}
        renderItem={renderItem}
        getItemType={() => 'provider'}
        ItemSeparatorComponent={PROVIDER_ROW_SEPARATOR}
        contentContainerStyle={listContentContainerStyle}
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
      <ScreenHeader title={t('profile.providerKeys.chooseProvider')} />
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
