import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { selectionHaptic } from '@/lib/haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { AlertCircle, Info, Plus, SearchX, X } from '@/components/ui/icons';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { type TextInput, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { ModelPickerOptionRow } from '@/components/agents/model-selector';
import { EmptyState, StateAction } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { SearchField } from '@/components/ui/search-field';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { providerKeyAddHref } from '@/lib/byok/provider-key-scope';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  buildModelPickerRows,
  favoriteToggleAction,
  type ModelPickerRow,
} from '@/lib/model-picker-rows';
import { commitModelPickerSelection, resolveModelPickerSelection } from '@/lib/picker-bridge';
import { dismissSearchPickerKeyboard, SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';
import { parseParam } from '@/lib/route-params';
import { modelPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';
import { useSideInsetMarginStyle } from '@/lib/screen-insets';

// The picker sheet renders its own scroll container (`scrollable={false}`), so
// the list fills the sheet's body.
const listStyle = { flex: 1 } satisfies ViewStyle;

export function ModelPickerContent() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const sideInsetMarginStyle = useSideInsetMarginStyle();
  const { favorites, favoritesError, addFavorite, removeFavorite } = useModelPreferences(undefined);
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const { routeKey: rawRouteKey } = useLocalSearchParams<{ routeKey?: string }>();
  const routeKey = parseParam(rawRouteKey) ?? UNFENCED_ROUTE_KEY;
  useRouteRegistry(routeKey);
  const [search, setSearch] = useState('');
  // The input stays urgent; the list derivation and its rows trail behind so a
  // typing burst on a large catalog does not filter/reconcile on every key.
  const deferredSearch = useDeferredValue(search);
  // The input remains uncontrolled (iOS TextInput rules), so the in-field X
  // clears the native text imperatively and `search` stays the rows' source.
  const searchInputRef = useRef<TextInput>(null);
  const listRef = useRef<FlashListRef<ModelPickerRow>>(null);
  const [bridge, setBridge] = useState(() => modelPickerSlot.get(routeKey));
  const [selectedModel, setSelectedModel] = useState(bridge?.currentValue ?? '');
  const [selectedVariant, setSelectedVariant] = useState(bridge?.currentVariant ?? '');
  const bridgeRef = useRef(bridge);
  const selectedModelRef = useRef(selectedModel);
  const selectedVariantRef = useRef(selectedVariant);
  const selectionChangedRef = useRef(false);
  // Set only by the closes that keep the pick: Done, and the pick's own close
  // (a single-effort model, or an effort chip). Every other way out — Cancel,
  // Android Back, an iOS swipe-down — leaves it unset, so the focus cleanup
  // drops a pick still waiting for its effort and the caller keeps its model.
  const commitOnCloseRef = useRef(false);
  const closePickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closePicker = useCallback(() => {
    commitOnCloseRef.current = true;
    router.back();
  }, [router]);

  const cancelPicker = useCallback(() => {
    router.back();
  }, [router]);

  // A caller that keeps no variant cannot apply an effort picked here, so the
  // rows leave the chips out and a model tap is the whole selection. Read from
  // the bridge rather than a prop: the slot is the picker route's only input.
  const acceptsVariant = bridge?.acceptsVariant ?? true;

  useFocusEffect(
    useCallback(() => {
      const nextBridge = modelPickerSlot.get(routeKey);
      const nextModel = nextBridge?.currentValue ?? '';
      const nextVariant = nextBridge?.currentVariant ?? '';

      bridgeRef.current = nextBridge;
      selectedModelRef.current = nextModel;
      selectedVariantRef.current = nextVariant;
      selectionChangedRef.current = false;
      commitOnCloseRef.current = false;
      setBridge(nextBridge);
      setSelectedModel(nextModel);
      setSelectedVariant(nextVariant);
      setSearch('');
      searchInputRef.current?.clear();

      return () => {
        if (closePickerTimerRef.current) {
          clearTimeout(closePickerTimerRef.current);
          closePickerTimerRef.current = null;
        }

        const activeBridge = bridgeRef.current;
        if (activeBridge && selectionChangedRef.current && commitOnCloseRef.current) {
          commitModelPickerSelection(
            activeBridge,
            selectedModelRef.current,
            selectedVariantRef.current
          );
        }
        modelPickerSlot.clear(routeKey);
        bridgeRef.current = undefined;
      };
    }, [routeKey])
  );

  const rows = useMemo<ModelPickerRow[]>(
    () =>
      buildModelPickerRows({ models: bridge?.options ?? [], search: deferredSearch, favoriteIds }),
    [bridge, deferredSearch, favoriteIds]
  );

  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [deferredSearch]);

  // Shared by the in-field X and the "No matches" empty state's CTA: drops the
  // query and the input's visible text in one step, so the full list returns
  // without backspacing.
  const handleClearSearch = useCallback(() => {
    searchInputRef.current?.clear();
    setSearch('');
  }, []);

  // The favorite star button in ModelPickerOptionRow already fires its own
  // selection haptic on press — this callback must not fire a second one.
  const handleToggleFavorite = useCallback(
    (option: SessionModelOption) => {
      const action = favoriteToggleAction(option, favorites);
      if (action.type === 'remove') {
        for (const model of action.models) {
          removeFavorite({ model });
        }
      } else {
        addFavorite({ model: action.model });
      }
    },
    [favorites, addFavorite, removeFavorite]
  );

  const handleSelectVariant = useCallback(
    (variant: string) => {
      selectionHaptic();
      dismissSearchPickerKeyboard();
      selectionChangedRef.current = true;
      selectedVariantRef.current = variant;
      setSelectedVariant(variant);

      if (closePickerTimerRef.current) {
        clearTimeout(closePickerTimerRef.current);
      }
      closePickerTimerRef.current = setTimeout(() => {
        closePickerTimerRef.current = null;
        closePicker();
      }, 175);
    },
    [closePicker]
  );

  const handleSelectModel = useCallback(
    (option: SessionModelOption) => {
      if (option.unavailable || !bridge) {
        return;
      }
      selectionHaptic();
      const selection = resolveModelPickerSelection(bridge, option.id, selectedVariantRef.current);
      if (!selection) {
        return;
      }

      // The pick is applied: close the search keyboard with it, so the chosen
      // row's check mark and its thinking-effort chips are visible whether or
      // not the sheet stays open for a variant choice.
      dismissSearchPickerKeyboard();
      selectionChangedRef.current = true;
      selectedModelRef.current = option.id;
      selectedVariantRef.current = selection.variant;
      setSelectedModel(option.id);
      setSelectedVariant(selection.variant);
      if (!acceptsVariant || option.variants.length <= 1) {
        closePicker();
      }
    },
    [acceptsVariant, bridge, closePicker]
  );

  // Hoisted out of the list body: the inline arrow gave the virtualized list a
  // new renderer on every render, which re-rendered every mounted row. Height
  // differs between the group header and a model row, so `getItemType` lets
  // FlashList recycle the two apart.
  const renderItem = useCallback(
    ({ item }: { item: ModelPickerRow | undefined }) => {
      // A stale index past the end of the rows (see `keyExtractor` below).
      if (!item) {
        return null;
      }
      if (item.type === 'header') {
        return <SectionHeader inset label={item.title} />;
      }

      return (
        <ModelPickerOptionRow
          option={item.model}
          selected={item.model.id === selectedModel}
          selectedVariant={selectedVariant}
          acceptsVariant={acceptsVariant}
          isFavorite={item.isFavorite}
          showProvider={item.showsProvider}
          onSelectModel={handleSelectModel}
          onSelectVariant={handleSelectVariant}
          onToggleFavorite={handleToggleFavorite}
        />
      );
    },
    [
      acceptsVariant,
      handleSelectModel,
      handleSelectVariant,
      handleToggleFavorite,
      selectedModel,
      selectedVariant,
    ]
  );

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.modelPicker.title')}
        onDone={closePicker}
        onCancel={cancelPicker}
        scrollable={false}
        expired
      />
    );
  }

  // A remote session whose CLI reports no models projects one row with
  // `unavailable: true` and the session's current selection, so the sheet drew
  // a dead row with no explanation of why it could not be picked. The state
  // sits in the list header rather than in the zero-rows branch so the row the
  // session is on, the search field and the sheet's height keep their places;
  // `instance-picker`'s zero-instance state is the same shape. The state also
  // owns the way out: an unavailable model is a missing credential, so its one
  // action opens the provider-key form instead of leaving the sheet a dead end.
  const allOptionsUnavailable =
    bridge.options.length > 0 && bridge.options.every(option => option.unavailable === true);

  return (
    <PickerSheet
      title={t('agentChat.modelPicker.title')}
      onDone={closePicker}
      onCancel={cancelPicker}
      scrollable={false}
      headerContent={
        <View>
          <SearchField
            className="mx-4 my-3"
            inputRef={searchInputRef}
            placeholder={t('common.searchModels')}
            hasText={search.length > 0}
            onChangeText={setSearch}
            onClear={handleClearSearch}
          />
          {favoritesError ? (
            <View className="mx-4 mb-3 flex-row items-center gap-1.5">
              <AlertCircle size={14} color={colors.destructive} />
              <Text className="text-xs text-destructive">{favoritesError}</Text>
            </View>
          ) : null}
        </View>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={deferredSearch.trim() ? SearchX : Info}
          title={
            deferredSearch.trim()
              ? t('agentChat.repoPicker.noMatches')
              : t('common.noModelsAvailable')
          }
          description={
            deferredSearch.trim()
              ? t('agents.sessionList.tryDifferentSearch')
              : t('agentChat.modelPicker.noModelsDescription')
          }
          action={
            // The in-field X is one way back; the no-matches body offers the
            // same recovery the Agents search empty state does, so the only
            // exit from "No matches" is not backspacing the query away.
            deferredSearch.trim() ? (
              <StateAction label={t('common.clearSearch')} icon={X} onPress={handleClearSearch} />
            ) : undefined
          }
        />
      ) : (
        // No wrapping View: react-native-screens honors the formSheet header
        // only when [header, scroll view] are the content's direct children,
        // so the list itself carries the sheet background.
        //
        // The bottom inset rides on the list's frame, not its content: a content
        // inset only cleared the end of the list, so a row at the viewport bottom
        // (the picker's last row) was drawn under the opaque Android navigation
        // bar. Ending the viewport above the bar is the same frame inset
        // `session-list-screen` uses for its FAB band.
        <FlashList<ModelPickerRow>
          nestedScrollEnabled
          ref={listRef}
          maintainVisibleContentPosition={{ disabled: true }}
          style={[
            listStyle,
            { backgroundColor: colors.background, marginBottom: bottom },
            sideInsetMarginStyle,
          ]}
          data={rows}
          ListHeaderComponent={
            allOptionsUnavailable ? (
              <EmptyState
                // The sheet's sections sit 21pt apart; the state is the
                // first block above them, so it ends at the same gap.
                className="mb-6"
                icon={Info}
                placement="top"
                inset="gutter"
                compact
                title={t('agentChat.modelPicker.allUnavailableTitle')}
                description={t('agentChat.modelPicker.allUnavailableDescription')}
                // The state is not a dead end: the only surface that can make
                // these models pickable again holds the provider keys.
                action={
                  <StateAction
                    label={t('profile.providerKeys.add')}
                    icon={Plus}
                    onPress={() => {
                      // The slot is cleared when the sheet loses focus, so
                      // opening the key flow on top of it would come back to
                      // an expired picker: close the sheet with no pick, then
                      // open the provider-key flow from the chat surface.
                      cancelPicker();
                      router.push(providerKeyAddHref({ kind: 'personal' }));
                    }}
                  />
                }
              />
            ) : undefined
          }
          // FlashList stores its props during render. When React discards a
          // deferred search render, FlashList can keep that render's shorter
          // rows and then ask for a row past their end, so the row can be
          // undefined (Sentry KILO-APP-3K0). It indexes `data` without a bounds
          // check for `renderItem` too, which renders nothing for such a row.
          // The key and type fallbacks are the ones FlashList uses when these
          // callbacks are absent.
          keyExtractor={(item: ModelPickerRow | undefined, index) => item?.key ?? String(index)}
          getItemType={(item: ModelPickerRow | undefined) => item?.type}
          {...SEARCHABLE_PICKER_LIST_PROPS}
          renderItem={renderItem}
        />
      )}
    </PickerSheet>
  );
}
