import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow } from '@/components/ui/choice-row';
import { PickerSheet } from '@/components/picker-sheet';
import { Text } from '@/components/ui/text';
import { type LocalRuntimeCatalog } from '@/lib/hooks/local-runtime-catalog-types';
import {
  clearRuntimeCatalogModelPickerBridge,
  commitRuntimeCatalogModelPickerSelection,
  getRuntimeCatalogModelPickerBridge,
} from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

type Row =
  | { kind: 'header'; key: string; title: string }
  | {
      kind: 'model';
      key: string;
      providerID: string;
      providerName: string;
      modelID: string;
      modelName: string;
      variants: string[];
    };

function projectCatalogRows(catalog: LocalRuntimeCatalog): Row[] {
  const rows: Row[] = [];
  for (const provider of catalog.models.providers) {
    rows.push({
      kind: 'header',
      key: `provider-${provider.id}`,
      title: (provider.name ?? provider.id).toUpperCase(),
    });
    for (const model of provider.models) {
      rows.push({
        kind: 'model',
        key: `model-${provider.id}-${model.id}`,
        providerID: provider.id,
        providerName: provider.name ?? provider.id,
        modelID: model.id,
        modelName: model.name ?? model.id,
        variants: model.variants,
      });
    }
  }
  return rows;
}

/**
 * Renders the runtime-catalog model picker. Reads the published bridge, lists
 * every model grouped by provider, and commits a tap through
 * `commitRuntimeCatalogModelPickerSelection`. The commit helper performs the
 * staleness checks (scope, catalog identity, fence match) so this component
 * just forwards the tap.
 */
export function RuntimeCatalogModelPickerContent() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const [bridge] = useState(() => getRuntimeCatalogModelPickerBridge());
  const bridgeRef = useRef(bridge);

  useEffect(
    () => () => {
      clearRuntimeCatalogModelPickerBridge();
    },
    []
  );

  useEffect(() => {
    bridgeRef.current = bridge;
  }, [bridge]);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  const rows = useMemo<Row[]>(() => (bridge ? projectCatalogRows(bridge.catalog) : []), [bridge]);

  const handleSelect = useCallback(
    (model: Extract<Row, { kind: 'model' }>, variant: string) => {
      const active = bridgeRef.current;
      if (!active) {
        return;
      }
      commitRuntimeCatalogModelPickerSelection(active, {
        providerID: model.providerID,
        modelID: model.modelID,
        variant,
      });
      closePicker();
    },
    [closePicker]
  );

  if (!bridge) {
    return <PickerSheet title="Select model" onDone={closePicker} expired />;
  }

  return (
    <PickerSheet title="Select model" onDone={closePicker} scrollable={false}>
      <FlatList
        className="flex-1 bg-background"
        data={rows}
        keyExtractor={item => item.key}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: bottom }}
        renderItem={({ item }) => {
          if (item.kind === 'header') {
            return (
              <View className="bg-secondary px-4 py-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {item.title}
                </Text>
              </View>
            );
          }
          const selected = bridge.currentValue === item.modelID;
          return (
            <View className="px-4">
              <ChoiceRow
                label={`${item.providerName} · ${item.modelName}`}
                description={`${item.modelID} · ${item.variants.length} variant${
                  item.variants.length === 1 ? '' : 's'
                }`}
                selected={selected}
                onPress={() => {
                  const variant = item.variants[0] ?? '';
                  handleSelect(item, variant);
                }}
              />
              {item.variants.length > 1 ? (
                <View className="flex-row flex-wrap gap-2 pb-3 pl-1 pr-1">
                  {item.variants.map(variant => {
                    const active = selected && bridge.currentVariant === variant;
                    return (
                      <Pressable
                        key={`${item.key}-${variant}`}
                        onPress={() => {
                          handleSelect(item, variant);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`${item.modelName} ${variant} variant${
                          active ? ', selected' : ''
                        }`}
                        className={cn(
                          'rounded-full px-3 py-1.5 active:opacity-70',
                          active ? 'bg-foreground' : 'bg-secondary'
                        )}
                      >
                        <Text
                          className={cn(
                            'text-sm font-medium',
                            active ? 'text-background' : 'text-foreground'
                          )}
                        >
                          {variant}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </PickerSheet>
  );
}
