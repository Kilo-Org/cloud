import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { SearchX } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroupItem, rowGroupPosition } from '@/components/ui/row-group';
import { SearchField } from '@/components/ui/search-field';
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

/** The search field and filter row both lists carry above their rows. */
function ListHeader({
  description,
  searchPlaceholder,
  search,
  onSearchChange,
  filter,
  bulk,
  showControls = true,
}: Readonly<{
  description: string;
  searchPlaceholder: string;
  search: string;
  onSearchChange: (next: string) => void;
  filter?: ReactNode;
  bulk: ReactNode;
  /** `false` renders the description alone, for a list with nothing to search. */
  showControls?: boolean;
}>) {
  return (
    <View className="gap-3 pt-3 pb-3">
      <Text variant="muted">{description}</Text>
      {showControls ? (
        <>
          <SearchField
            defaultValue={search}
            placeholder={searchPlaceholder}
            hasText={search !== ''}
            onChangeText={onSearchChange}
          />
          <View className="flex-row flex-wrap items-center gap-2">
            {filter}
            {bulk}
          </View>
        </>
      ) : null}
    </View>
  );
}

function NoMatch({ label }: Readonly<{ label: string }>) {
  // The list's content container carries the page gutter, so the state adds none.
  return <EmptyState icon={SearchX} title={label} inset="none" className="bg-background py-8" />;
}

/**
 * The organization's allowed providers: one switch per provider the catalog can
 * route to. An empty allow list would block every model, so the switch row
 * reads the draft's own membership rather than a separate flag.
 *
 * A row is titled with the provider's display name and shows the slug under it,
 * the way the deny list titles a model and puts its id beneath. A provider whose
 * name the gateway does not answer for keeps the slug as its title, with no
 * subtitle.
 */
export function ProviderAllowList({
  providers,
  names,
  draft,
  onChange,
  disabled,
}: Readonly<{
  providers: readonly string[];
  names: Readonly<Record<string, string>>;
  draft: ModelAccessDraft;
  onChange: (next: ModelAccessDraft) => void;
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const paddingBottom = useTabBarBottomPadding();
  const contentContainerStyle = { paddingBottom };
  // A row is searchable by its slug and by the name it shows, so a query typed
  // from either answer finds it.
  const shown = providers.filter(provider => matchesSearch([provider, names[provider]], search));
  // With no row at all there is nothing to search and nothing to act on in
  // bulk, so the intro line and the empty state are the whole tab. A query
  // typed over a non-empty list keeps the controls, so its no-match state can
  // still be undone.
  const showControls = providers.length > 0 || search.trim() !== '';

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<string>) => (
      <RowGroupItem
        position={rowGroupPosition({ first: index === 0, last: index === shown.length - 1 })}
      >
        <PreferenceRow
          title={names[item] ?? item}
          subtitle={names[item] === undefined ? undefined : item}
          value={draft.providerAllowList.includes(item)}
          disabled={disabled}
          onValueChange={next => {
            onChange(toggleProvider(draft, item, next));
          }}
        />
      </RowGroupItem>
    ),
    [draft, disabled, names, onChange, shown.length]
  );

  // Two causes leave the list empty: a query filtered every provider out, or
  // the catalog names no provider at all.
  const emptyLabel = search.trim()
    ? t('organizationModelAccess.providersEmpty')
    : t('organizationModelAccess.providersNone');

  return (
    <FlashList
      data={shown}
      keyExtractor={provider => provider}
      renderItem={renderItem}
      style={listStyle}
      contentContainerClassName="px-4"
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <ListHeader
          description={t('organizationModelAccess.providersDescription')}
          searchPlaceholder={t('profile.providerKeys.searchProviders')}
          search={search}
          onSearchChange={setSearch}
          showControls={showControls}
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
      ListEmptyComponent={<NoMatch label={emptyLabel} />}
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
  const contentContainerStyle = { paddingBottom };
  const shown = models.filter(
    model =>
      matchesSearch([model.name, model.id], search) &&
      (!deniedOnly || draft.modelDenyList.includes(model.id))
  );
  const shownIds = shown.map(model => model.id);

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<DenyListModel>) => (
      <RowGroupItem
        position={rowGroupPosition({ first: index === 0, last: index === shown.length - 1 })}
      >
        <PreferenceRow
          title={item.name}
          subtitle={item.id}
          note={denyListRowNote(item, t)}
          value={!draft.modelDenyList.includes(item.id)}
          disabled={disabled}
          onValueChange={next => {
            onChange(toggleModel(draft, item.id, next));
          }}
        />
      </RowGroupItem>
    ),
    [draft, disabled, onChange, shown.length, t]
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
      style={listStyle}
      contentContainerClassName="px-4"
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
