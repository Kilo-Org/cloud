import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow } from '@/components/ui/choice-row';
import { PickerSheet } from '@/components/picker-sheet';
import {
  clearRuntimePickerBridge,
  commitRuntimePickerSelection,
  getRuntimePickerBridge,
} from '@/lib/picker-bridge';
import {
  hasCatalogCapability,
  type LocalRuntime,
} from '@/lib/hooks/local-runtime-catalog-selection';
import { RUNTIME_DISCOVERY_COPY } from '@/lib/hooks/runtime-discovery-logic';

/**
 * Renders the list of connected local runtimes for the configuration screen.
 * Reads the published bridge, commits a tap back through
 * `commitRuntimePickerSelection`, and discards the tap when the scope is no
 * longer current or the candidate fence is not in the live list.
 *
 * The picker is a one-shot modal: it always closes after a tap is resolved
 * and clears the bridge in its unmount effect so the next open republishes
 * a fresh scope.
 */
export function RuntimePickerContent() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const [bridge] = useState(() => getRuntimePickerBridge());
  const bridgeRef = useRef(bridge);

  useEffect(
    () => () => {
      clearRuntimePickerBridge();
    },
    []
  );

  useEffect(() => {
    bridgeRef.current = bridge;
  }, [bridge]);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  const handleSelect = useCallback(
    (runtime: LocalRuntime) => {
      const active = bridgeRef.current;
      if (!active) {
        return;
      }
      commitRuntimePickerSelection(active, runtime.runtimeId, runtime.connectionId);
      closePicker();
    },
    [closePicker]
  );

  if (!bridge) {
    return <PickerSheet title="Select runtime" onDone={closePicker} expired />;
  }

  return (
    <PickerSheet title="Select runtime" onDone={closePicker}>
      <FlatList
        className="bg-background"
        data={bridge.runtimes}
        keyExtractor={item => `${item.runtimeId}:${item.connectionId}`}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: bottom + 16 }}
        renderItem={({ item }) => {
          const incapable = !hasCatalogCapability(item);
          const selected =
            bridge.currentFence !== null &&
            bridge.currentFence.runtimeId === item.runtimeId &&
            bridge.currentFence.connectionId === item.connectionId;
          const subtitle = incapable
            ? RUNTIME_DISCOVERY_COPY.incapable
            : `${item.projectName} · CLI ${item.cliVersion}`;
          return (
            <ChoiceRow
              label={item.displayName}
              description={subtitle}
              selected={selected}
              disabled={incapable}
              onPress={() => {
                handleSelect(item);
              }}
            />
          );
        }}
      />
    </PickerSheet>
  );
}
