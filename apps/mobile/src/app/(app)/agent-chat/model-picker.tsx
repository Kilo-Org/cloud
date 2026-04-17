import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { Check, Search } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type ModelOption, thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { clearModelPickerBridge, getModelPickerBridge } from '@/lib/picker-bridge';

type ModelPickerRow =
  | { key: string; title: string; type: 'header' }
  | { key: string; model: ModelOption; type: 'model' };

function getVariantForModel(model: ModelOption, currentVariant: string) {
  if (currentVariant && model.variants.includes(currentVariant)) {
    return currentVariant;
  }
  return model.variants[0] ?? '';
}

export default function ModelPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [search, setSearch] = useState('');
  const [bridge, setBridge] = useState(() => getModelPickerBridge());

  const [selectedModel, setSelectedModel] = useState(bridge?.currentValue ?? '');
  const [selectedVariant, setSelectedVariant] = useState(bridge?.currentVariant ?? '');

  const bridgeRef = useRef(bridge);
  const selectedModelRef = useRef(selectedModel);
  const selectedVariantRef = useRef(selectedVariant);
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
        if (activeBridge) {
          activeBridge.onSelect(selectedModelRef.current, selectedVariantRef.current);
          clearModelPickerBridge();
          bridgeRef.current = null;
        }
      };
    }, [])
  );

  const currentModelOption = useMemo(
    () => bridge?.options.find(m => m.id === selectedModel),
    [bridge, selectedModel]
  );

  useEffect(() => {
    if (!currentModelOption) {
      return;
    }

    const nextVariant = getVariantForModel(currentModelOption, selectedVariantRef.current);
    if (nextVariant === selectedVariantRef.current) {
      return;
    }

    selectedVariantRef.current = nextVariant;
    setSelectedVariant(nextVariant);
  }, [currentModelOption]);

  const rows = useMemo<ModelPickerRow[]>(() => {
    if (!bridge) {
      return [];
    }

    const query = search.toLowerCase().trim();
    const filtered = bridge.options.filter(
      m => !query || m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)
    );

    const recommended = filtered.filter(m => m.isPreferred);
    const all = filtered.filter(m => !m.isPreferred);
    const result: ModelPickerRow[] = [];

    if (recommended.length > 0) {
      result.push({ key: 'recommended', title: 'RECOMMENDED', type: 'header' });
      for (const modelOption of recommended) {
        result.push({ key: `model:${modelOption.id}`, model: modelOption, type: 'model' });
      }
    }
    if (all.length > 0) {
      result.push({ key: 'all', title: 'ALL MODELS', type: 'header' });
      for (const modelOption of all) {
        result.push({ key: `model:${modelOption.id}`, model: modelOption, type: 'model' });
      }
    }
    return result;
  }, [bridge, search]);

  const handleSelectVariant = useCallback(
    (variant: string) => {
      void Haptics.selectionAsync();
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
    (id: string) => {
      void Haptics.selectionAsync();
      const model = bridge?.options.find(m => m.id === id);
      if (!model) {
        return;
      }

      const nextVariant = getVariantForModel(model, selectedVariantRef.current);
      selectedModelRef.current = id;
      selectedVariantRef.current = nextVariant;
      setSelectedModel(id);
      setSelectedVariant(nextVariant);

      if (model.variants.length <= 1) {
        closePicker();
      }
    },
    [bridge, closePicker]
  );

  if (!bridge) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-muted-foreground">No models available</Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <View className="border-b border-border bg-background px-4 pb-3 pt-4">
        <View className="h-11 flex-row items-center justify-center">
          <Text className="text-lg font-semibold text-foreground">Select Model</Text>
          <Pressable
            onPress={closePicker}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Done selecting model"
            className="absolute right-0 rounded-full bg-secondary px-4 py-2 active:opacity-70 will-change-pressable"
          >
            <Text className="text-base font-medium text-foreground">Done</Text>
          </Pressable>
        </View>
        <View className="mt-2 flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2">
          <Search size={18} color={colors.mutedForeground} />
          <TextInput
            placeholder="Search models..."
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
            className="h-8 flex-1 p-0 text-base text-foreground"
            style={{ color: colors.foreground }}
            onChangeText={setSearch}
          />
        </View>
      </View>

      {rows.length === 0 ? (
        <View className="items-center justify-center px-6 py-16">
          <Text className="text-center text-sm text-muted-foreground">
            {search.trim() ? 'No models match your search' : 'No models available'}
          </Text>
        </View>
      ) : (
        rows.map(item => {
          if (item.type === 'header') {
            return (
              <View key={item.key} className="bg-secondary px-4 py-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {item.title}
                </Text>
              </View>
            );
          }

          const modelOption = item.model;
          const selected = modelOption.id === selectedModel;
          const hasVariants = modelOption.variants.length > 1;

          return (
            <View key={item.key} className="border-b border-border">
              <Pressable
                className="flex-row items-center gap-3 px-4 py-3 active:bg-secondary will-change-pressable"
                onPress={() => {
                  handleSelectModel(modelOption.id);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${modelOption.name}${selected ? ', selected' : ''}`}
              >
                <View className="flex-1">
                  <Text className="text-base text-foreground">{modelOption.name}</Text>
                  <Text className="text-xs text-muted-foreground">{modelOption.id}</Text>
                </View>
                {selected && <Check size={18} color={colors.primary} />}
              </Pressable>

              {selected && hasVariants ? (
                <View className="px-4 pb-3">
                  <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Thinking effort
                  </Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerClassName="gap-2"
                    keyboardShouldPersistTaps="handled"
                  >
                    {modelOption.variants.map(variant => {
                      const isActive = variant === selectedVariant;
                      return (
                        <Pressable
                          key={variant}
                          className={`rounded-full px-3 py-1.5 ${isActive ? 'bg-foreground' : 'bg-secondary'}`}
                          onPress={() => {
                            handleSelectVariant(variant);
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={`${thinkingEffortLabel(variant)} thinking effort${isActive ? ', selected' : ''}`}
                        >
                          <Text
                            className={`text-sm font-medium ${isActive ? 'text-background' : 'text-foreground'}`}
                          >
                            {thinkingEffortLabel(variant)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}
