import { Modal, Platform, Pressable, Switch, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ReasoningSettingsModalProps = {
  visible: boolean;
  onClose: () => void;
};

export function ReasoningSettingsModal({
  visible,
  onClose,
}: Readonly<ReasoningSettingsModalProps>) {
  const colors = useThemeColors();
  const { defaultExpanded, hasLoaded, setDefaultExpanded } = useReasoningPreference();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        className="flex-1 justify-start px-6 pt-[20%]"
        onPress={onClose}
        // accessible={false} so the backdrop doesn't collapse the whole sheet
        // into one VoiceOver node (a Pressable defaults to accessible=true) —
        // same fix as platform-filter-modal. VoiceOver dismissal comes from the
        // modal's onRequestClose escape gesture, not this backdrop.
        accessible={false}
      >
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          className="rounded-xl bg-card p-5 gap-4"
          accessible={false}
          onPress={event => {
            event.stopPropagation();
          }}
        >
          <Text className="text-base font-semibold text-foreground">Reasoning</Text>
          {/* The native Switch below is the single accessible control (it already
              exposes an accessibility switch role/state on its own); this row is
              a visual hit-target only, so a screen reader doesn't see two nested
              switches. */}
          <Pressable
            onPress={() => {
              if (!hasLoaded) {
                return;
              }
              setDefaultExpanded(!defaultExpanded);
            }}
            disabled={!hasLoaded}
            accessible={false}
            className="flex-row items-center justify-between gap-3 rounded-lg p-2 active:opacity-70 disabled:opacity-50"
            hitSlop={
              Platform.OS === 'android' ? { top: 12, bottom: 12, left: 12, right: 12 } : undefined
            }
          >
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground">
                Expand reasoning by default
              </Text>
              <Text className="mt-1 text-xs text-muted-foreground">
                Show the assistant's reasoning expanded when it finishes.
              </Text>
            </View>
            <Switch
              value={defaultExpanded}
              onValueChange={setDefaultExpanded}
              disabled={!hasLoaded}
              accessibilityLabel="Expand reasoning by default"
              trackColor={{ false: colors.muted, true: colors.accentSoft }}
              thumbColor={defaultExpanded ? colors.accentSoftForeground : '#FFFFFF'}
            />
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
