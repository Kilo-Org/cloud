import { FlashList } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { AlertCircle, Info, Search, SearchX, X } from '@/components/ui/icons';
import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Pressable, type TextInput, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { ModelPickerOptionRow } from '@/components/agents/model-selector';
import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  buildModelPickerRows,
  favoriteToggleAction,
  type ModelPickerRow,
} from '@/lib/model-picker-rows';
import { commitModelPickerSelection, resolveModelPickerSelection } from '@/lib/picker-bridge';
import { parseParam } from '@/lib/route-params';
import { modelPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';
import { withRtlInputAlignment } from '@/lib/rtl-text';

// The picker sheet renders its own scroll container (`scrollable={false}`), so
// the list fills the sheet's body.
const listStyle = { flex: 1 } satisfies ViewStyle;

export function ModelPickerContent() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
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
  const [bridge, setBridge] = useState(() => modelPickerSlot.get(routeKey));
  const [selectedModel, setSelectedModel] = useState(bridge?.currentValue ?? '');
  const [selectedVariant, setSelectedVariant] = useState(bridge?.currentVariant ?? '');
  const bridgeRef = useRef(bridge);
  const selectedModelRef = useRef(selectedModel);
  const selectedVariantRef = useRef(selectedVariant);
  const selectionChangedRef = useRef(false);
  const closePickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      const nextBridge = modelPickerSlot.get(routeKey);
      const nextModel = nextBridge?.currentValue ?? '';
      const nextVariant = nextBridge?.currentVariant ?? '';

      bridgeRef.current = nextBridge;
      selectedModelRef.current = nextModel;
      selectedVariantRef.current = nextVariant;
      selectionChangedRef.current = false;
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
        if (activeBridge && selectionChangedRef.current) {
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

  // Shared by the in-field X and the "No matches" empty state's CTA: drops the
  // query and the input's visible text in one step, so the full list returns
  // without backspacing. The field carries its own control because Android has
  // no native `clearButtonMode` counterpart.
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
      void Haptics.selectionAsync();
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
      void Haptics.selectionAsync();
      const selection = resolveModelPickerSelection(bridge, option.id, selectedVariantRef.current);
      if (!selection) {
        return;
      }

      selectionChangedRef.current = true;
      selectedModelRef.current = option.id;
      selectedVariantRef.current = selection.variant;
      setSelectedModel(option.id);
      setSelectedVariant(selection.variant);
      if (option.variants.length <= 1) {
        closePicker();
      }
    },
    [bridge, closePicker]
  );

  // Hoisted out of the list body: the inline arrow gave the virtualized list a
  // new renderer on every render, which re-rendered every mounted row. Height
  // differs between the group header and a model row, so `getItemType` lets
  // FlashList recycle the two apart.
  const renderItem = useCallback(
    ({ item }: { item: ModelPickerRow }) => {
      if (item.type === 'header') {
        return (
          <View className="bg-secondary px-4 py-2">
            <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {item.title}
            </Text>
          </View>
        );
      }

      return (
        <ModelPickerOptionRow
          option={item.model}
          selected={item.model.id === selectedModel}
          selectedVariant={selectedVariant}
          isFavorite={item.isFavorite}
          onSelectModel={handleSelectModel}
          onSelectVariant={handleSelectVariant}
          onToggleFavorite={handleToggleFavorite}
        />
      );
    },
    [handleSelectModel, handleSelectVariant, handleToggleFavorite, selectedModel, selectedVariant]
  );

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.modelPicker.title')}
        onDone={closePicker}
        scrollable={false}
        expired
      />
    );
  }

  return (
    <PickerSheet
      title={t('agentChat.modelPicker.title')}
      onDone={closePicker}
      scrollable={false}
      headerContent={
        <View>
          <View className="flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2 mx-4 mb-3 mt-3">
            <Search size={18} color={colors.mutedForeground} />
            <Input
              ref={searchInputRef}
              placeholder={t('common.searchModels')}
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              className="h-8 flex-1 p-0 text-base leading-[normal] text-foreground"
              style={withRtlInputAlignment(undefined)}
              onChangeText={setSearch}
            />
            {/* In-field clear, on every platform: `clearButtonMode` is iOS
                only, so Android rendered the query with no way to reset it. */}
            {search.length > 0 ? (
              <Pressable
                onPress={handleClearSearch}
                accessibilityLabel={t('common.clearSearch')}
                accessibilityRole="button"
                hitSlop={12}
                className="active:opacity-70"
              >
                <X size={16} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </View>
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
              <Button variant="outline" onPress={handleClearSearch}>
                <Text>{t('common.clearSearch')}</Text>
              </Button>
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
          style={[listStyle, { backgroundColor: colors.background, marginBottom: bottom }]}
          data={rows}
          keyExtractor={item => item.key}
          getItemType={item => item.type}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={renderItem}
        />
      )}
    </PickerSheet>
  );
}
