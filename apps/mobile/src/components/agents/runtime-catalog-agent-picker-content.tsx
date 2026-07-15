import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow } from '@/components/ui/choice-row';
import { PickerSheet } from '@/components/picker-sheet';
import {
  clearRuntimeCatalogAgentPickerBridge,
  commitRuntimeCatalogAgentPickerSelection,
  getRuntimeCatalogAgentPickerBridge,
} from '@/lib/picker-bridge';
import { type LocalRuntimeCatalog } from '@/lib/hooks/local-runtime-catalog-types';

type AgentRow = {
  key: string;
  slug: string;
  name: string;
  description?: string;
};

function projectCatalogAgents(catalog: LocalRuntimeCatalog): AgentRow[] {
  return catalog.agents.map(agent => ({
    key: `agent-${agent.slug}`,
    slug: agent.slug,
    name: agent.name,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
  }));
}

/**
 * Renders the runtime-catalog agent picker. Reads the published bridge,
 * lists every agent the catalog exposed, and commits a tap through
 * `commitRuntimeCatalogAgentPickerSelection`. The commit helper performs
 * the staleness checks (scope, catalog identity, fence match) so this
 * component just forwards the tap.
 */
export function RuntimeCatalogAgentPickerContent() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const [bridge] = useState(() => getRuntimeCatalogAgentPickerBridge());
  const bridgeRef = useRef(bridge);

  useEffect(
    () => () => {
      clearRuntimeCatalogAgentPickerBridge();
    },
    []
  );

  useEffect(() => {
    bridgeRef.current = bridge;
  }, [bridge]);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  const rows = useMemo<AgentRow[]>(
    () => (bridge ? projectCatalogAgents(bridge.catalog) : []),
    [bridge]
  );

  const handleSelect = useCallback(
    (row: AgentRow) => {
      const active = bridgeRef.current;
      if (!active) {
        return;
      }
      commitRuntimeCatalogAgentPickerSelection(active, { slug: row.slug });
      closePicker();
    },
    [closePicker]
  );

  if (!bridge) {
    return <PickerSheet title="Select agent" onDone={closePicker} expired />;
  }

  return (
    <PickerSheet title="Select agent" onDone={closePicker}>
      <FlatList
        className="bg-background"
        data={rows}
        keyExtractor={item => item.key}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: bottom + 16 }}
        renderItem={({ item }) => {
          const selected = bridge.currentValue === item.slug;
          return (
            <View className="px-4">
              <ChoiceRow
                label={item.name}
                description={item.description ?? item.slug}
                selected={selected}
                onPress={() => {
                  handleSelect(item);
                }}
              />
            </View>
          );
        }}
      />
    </PickerSheet>
  );
}
