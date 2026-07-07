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
        accessibilityLabel="Close reasoning settings"
      >
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          className="rounded-xl bg-card p-5 gap-4"
          onPress={event => {
            event.stopPropagation();
          }}
        >
          <Text className="text-base font-semibold text-foreground">Reasoning</Text>
          <Pressable
            onPress={() => {
              if (!hasLoaded) {
                return;
              }
              setDefaultExpanded(!defaultExpanded);
            }}
            disabled={!hasLoaded}
            className="flex-row items-center justify-between gap-3 rounded-lg p-2 active:opacity-70 disabled:opacity-50"
            accessibilityRole="switch"
            accessibilityState={{ checked: defaultExpanded, disabled: !hasLoaded }}
            accessibilityLabel="Expand reasoning by default"
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
              trackColor={{ false: colors.muted, true: colors.accentSoft }}
              thumbColor={defaultExpanded ? colors.accentSoftForeground : '#FFFFFF'}
            />
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
