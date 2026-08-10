import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { Cloud, Terminal } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  clearContinuePickerBridge,
  getContinuePickerBridge,
} from '@/components/agents/continue-picker-bridge';
import {
  type ContinuePickerRow,
  toContinuePickerRows,
} from '@/components/agents/continue-picker-rows';
import { type ContinuationDestination } from '@/components/agents/continuation-seed';
import { DestinationOptionRow } from '@/components/destination-option-row';
import { PickerSheet } from '@/components/picker-sheet';

const TITLE = 'Continue in a new session';

export default function ContinuePickerScreen() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const [bridge, setBridge] = useState(() => getContinuePickerBridge());
  const bridgeRef = useRef(bridge);
  // True once a row was tapped, so the unfocus cleanup does not also cancel.
  const pickedRef = useRef(false);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      const next = getContinuePickerBridge();
      bridgeRef.current = next;
      setBridge(next);
      // Every focus cycle starts unpicked, so a reused route instance still
      // cancels on a later dismissal.
      pickedRef.current = false;

      return () => {
        if (!pickedRef.current) {
          bridgeRef.current?.onCancel();
        }
        clearContinuePickerBridge();
        bridgeRef.current = null;
      };
    }, [])
  );

  const handleSelect = useCallback(
    (destination: ContinuationDestination) => {
      const current = bridgeRef.current;
      // The guard makes selection single-shot: a second tap during the dismiss
      // animation must not start a second continuation.
      if (!current || pickedRef.current) {
        return;
      }
      // Set the flag before `closePicker`, because `router.back()` can run the
      // unfocus cleanup synchronously. The cleanup then skips `onCancel` and
      // clears the module bridge, while the local `current` still runs the pick.
      pickedRef.current = true;
      void Haptics.selectionAsync();
      // Retire the bridge here, as every other picker route does, so the
      // outcome no longer depends on when the unfocus cleanup runs.
      clearContinuePickerBridge();
      bridgeRef.current = null;
      // Dismiss first: `onSelect` awaits a network call before it pushes the
      // next screen, so the sheet is already closing by then.
      closePicker();
      current.onSelect(destination);
    },
    [closePicker]
  );

  if (!bridge) {
    return <PickerSheet title={TITLE} onDone={closePicker} scrollable={false} expired />;
  }

  const rows = toContinuePickerRows(bridge.destinations);

  const renderItem = ({ item }: { item: ContinuePickerRow }) => (
    <DestinationOptionRow
      icon={item.icon === 'cloud' ? Cloud : Terminal}
      title={item.title}
      subtitle={item.subtitle}
      accessibilityLabel={`Continue on ${item.title}`}
      onPress={() => {
        handleSelect(item.destination);
      }}
    />
  );

  return (
    <PickerSheet title={TITLE} onDone={closePicker} scrollable={false}>
      <FlatList
        className="flex-1 bg-background"
        data={rows}
        keyExtractor={item => item.key}
        contentContainerStyle={{ paddingBottom: bottom }}
        renderItem={renderItem}
      />
    </PickerSheet>
  );
}
