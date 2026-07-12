import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { AlertCircle, Info, Search, SearchX } from 'lucide-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ModelPickerOptionRow } from '@/components/agents/model-selector';
import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Text } from '@/components/ui/text';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  buildModelPickerRows,
  modelPickerFavoriteId,
  type ModelPickerRow,
} from '@/lib/model-picker-rows';
import {
  clearModelPickerBridge,
  commitModelPickerSelection,
  getModelPickerBridge,
  resolveModelPickerSelection,
} from '@/lib/picker-bridge';

export function ModelPickerContent() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { favorites, favoritesError, toggleFavorite } = useModelPreferences(undefined);
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const [search, setSearch] = useState('');
  const [bridge, setBridge] = useState(() => getModelPickerBridge());
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
      const nextBridge = getModelPickerBridge();
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
        clearModelPickerBridge();
        bridgeRef.current = null;
      };
    }, [])
  );

  const rows = useMemo<ModelPickerRow[]>(
    () => buildModelPickerRows({ models: bridge?.options ?? [], search, favoriteIds }),
    [bridge, search, favoriteIds]
  );

  // The favorite star button in ModelPickerOptionRow already fires its own
  // selection haptic on press — this callback must not fire a second one.
  const handleToggleFavorite = useCallback(
    (option: SessionModelOption) => {
      toggleFavorite(modelPickerFavoriteId(option));
    },
    [toggleFavorite]
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

  if (!bridge) {
    return <PickerSheet title="Select model" onDone={closePicker} scrollable={false} expired />;
  }

  return (
    <PickerSheet title="Select model" onDone={closePicker} scrollable={false}>
      <FlatList
        className="flex-1 bg-background"
        data={rows}
        keyExtractor={item => item.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: bottom }}
        ListHeaderComponent={
          <View>
            <View className="flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2 mx-4 mb-3 mt-3">
              <Search size={18} color={colors.mutedForeground} />
              <TextInput
                placeholder="Search models..."
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                returnKeyType="search"
                className="h-8 flex-1 p-0 text-base leading-5 text-foreground"
                onChangeText={setSearch}
              />
            </View>
            {favoritesError ? (
              <View className="mx-4 mb-3 flex-row items-center gap-1.5">
                <AlertCircle size={14} color={colors.destructive} />
                <Text className="text-xs text-destructive">{favoritesError}</Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon={search.trim() ? SearchX : Info}
            placement="top"
            title={search.trim() ? 'No matches' : 'No models available'}
            description={
              search.trim() ? 'Try a different search term.' : 'No models are available to select.'
            }
          />
        }
        renderItem={({ item }) => {
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
        }}
      />
    </PickerSheet>
  );
}
