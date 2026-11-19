import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { SettingsSwitchRow } from '@/components/organization/settings-form-sections';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { SearchX } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import {
  type DenyListModel,
  denyListRowNote,
  matchesSearch,
  type ModelAccessDraft,
  setModelsAllowed,
  setProvidersAllowed,
  toggleModel,
  toggleProvider,
} from '@/lib/organization/model-access';

const listStyle = { flex: 1 } satisfies ViewStyle;

const ItemSeparator = () => <View className="h-2" />;

/** The search field and filter row both lists carry above their rows. */
function ListHeader({
  description,
  searchPlaceholder,
  search,
  onSearchChange,
  filter,
  bulk,
}: Readonly<{
  description: string;
  searchPlaceholder: string;
  search: string;
  onSearchChange: (next: string) => void;
  filter?: ReactNode;
  bulk: ReactNode;
}>) {
  return (
    <View className="gap-3 pb-3">
      <Text className="text-xs text-muted-foreground">{description}</Text>
      <Input
        defaultValue={search}
        placeholder={searchPlaceholder}
        accessibilityLabel={searchPlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onSearchChange}
      />
      <View className="flex-row flex-wrap items-center gap-2">
        {filter}
        {bulk}
      </View>
    </View>
  );
}

function NoMatch({ label }: Readonly<{ label: string }>) {
  return <EmptyState icon={SearchX} title={label} className="bg-background py-8" />;
}

/**
 * The organization's allowed providers: one switch per provider the catalog can
 * route to. An empty allow list would block every model, so the switch row
 * reads the draft's own membership rather than a separate flag.
 */
export function ProviderAllowList({
  providers,
  draft,
  onChange,
  disabled,
}: Readonly<{
  providers: readonly string[];
  draft: ModelAccessDraft;
  onChange: (next: ModelAccessDraft) => void;
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const paddingBottom = useTabBarBottomPadding();
  const contentContainerStyle = { paddingHorizontal: 16, paddingBottom };
  const shown = providers.filter(provider => matchesSearch([provider], search));

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<string>) => (
      <SettingsSwitchRow
        label={item}
        value={draft.providerAllowList.includes(item)}
        disabled={disabled}
        onValueChange={next => {
          onChange(toggleProvider(draft, item, next));
        }}
      />
    ),
    [draft, disabled, onChange]
  );

  return (
    <FlashList
      data={shown}
      keyExtractor={provider => provider}
      renderItem={renderItem}
      ItemSeparatorComponent={ItemSeparator}
      style={listStyle}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <ListHeader
          description={t('organizationModelAccess.providersDescription')}
          searchPlaceholder={t('profile.providerKeys.searchProviders')}
          search={search}
          onSearchChange={setSearch}
          bulk={
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || shown.length === 0}
                onPress={() => {
                  onChange(setProvidersAllowed(draft, shown, true));
                }}
              >
                <Text>{t('organizationModelAccess.allowAllShown')}</Text>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || shown.length === 0}
                onPress={() => {
                  onChange(setProvidersAllowed(draft, shown, false));
                }}
              >
                <Text>{t('organizationModelAccess.denyAllShown')}</Text>
              </Button>
            </>
          }
        />
      }
      ListEmptyComponent={<NoMatch label={t('organizationModelAccess.providersEmpty')} />}
    />
  );
}

/**
 * The organization's denied models: every model in the gateway's catalog with a
 * switch, on while the model is not in the deny list. The list comes from the
 * unfiltered catalog, so a model the policy already denies still renders and
 * can be allowed again. It can run to hundreds of models, so a search field and
 * the web page's denied-only filter narrow it.
 */
export function ModelDenyList({
  models,
  draft,
  onChange,
  disabled,
}: Readonly<{
  models: readonly DenyListModel[];
  draft: ModelAccessDraft;
  onChange: (next: ModelAccessDraft) => void;
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [deniedOnly, setDeniedOnly] = useState(false);
  const paddingBottom = useTabBarBottomPadding();
  const contentContainerStyle = { paddingHorizontal: 16, paddingBottom };
  const shown = models.filter(
    model =>
      matchesSearch([model.name, model.id], search) &&
      (!deniedOnly || draft.modelDenyList.includes(model.id))
  );
  const shownIds = shown.map(model => model.id);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<DenyListModel>) => (
      <SettingsSwitchRow
        label={item.name}
        note={denyListRowNote(item, t)}
        description={item.id}
        value={!draft.modelDenyList.includes(item.id)}
        disabled={disabled}
        onValueChange={next => {
          onChange(toggleModel(draft, item.id, next));
        }}
      />
    ),
    [draft, disabled, onChange, t]
  );

  const emptyLabel = (() => {
    if (deniedOnly && search.trim()) {
      return t('organizationModelAccess.modelsDeniedSearchEmpty');
    }
    if (deniedOnly) {
      return t('organizationModelAccess.modelsDeniedEmpty');
    }
    return t('organizationModelAccess.modelsEmpty');
  })();

  return (
    <FlashList
      data={shown}
      keyExtractor={model => model.id}
      renderItem={renderItem}
      ItemSeparatorComponent={ItemSeparator}
      style={listStyle}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <ListHeader
          description={t('organizationModelAccess.modelsDescription')}
          searchPlaceholder={t('common.searchModels')}
          search={search}
          onSearchChange={setSearch}
          filter={
            <FilterChip
              label={t('organizationModelAccess.modelsDeniedOnly')}
              selected={deniedOnly}
              onPress={() => {
                setDeniedOnly(current => !current);
              }}
            />
          }
          bulk={
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || shownIds.length === 0}
                onPress={() => {
                  onChange(setModelsAllowed(draft, shownIds, true));
                }}
              >
                <Text>{t('organizationModelAccess.allowAllShown')}</Text>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || shownIds.length === 0}
                onPress={() => {
                  onChange(setModelsAllowed(draft, shownIds, false));
                }}
              >
                <Text>{t('organizationModelAccess.denyAllShown')}</Text>
              </Button>
            </>
          }
        />
      }
      ListEmptyComponent={<NoMatch label={emptyLabel} />}
    />
  );
}
