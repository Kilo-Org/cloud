import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { InstanceSelector } from '@/components/agents/instance-selector';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { Button } from '@/components/ui/button';
import { RefreshCw } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { Text } from '@/components/ui/text';

type NewSessionRunTargetProps = {
  showRunOnSelector: boolean;
  runOnInstance: InstancePickerInstance | null;
  instanceList: InstancePickerInstance[];
  isLoadingInstances: boolean;
  isFetchingInstances: boolean;
  /**
   * The computer target is selected with no computer bound yet (the tour's
   * computer path with zero connected computers): the selector shows the
   * no-computer copy instead of the Cloud Agent label.
   */
  pendingComputer?: boolean;
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
  onRefreshInstances: () => void;
  disabled: boolean;
};

const REFRESH_SPIN_MS = 800;

/**
 * The Run-on block of the new-session form: the instance selector plus its
 * refresh control when the selector is offered, or a read-only target line
 * naming the instance a clone continues on.
 */
export function NewSessionRunTarget({
  showRunOnSelector,
  runOnInstance,
  instanceList,
  isLoadingInstances,
  isFetchingInstances,
  pendingComputer,
  onChangeRunOnInstance,
  onRefreshInstances,
  disabled,
}: Readonly<NewSessionRunTargetProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  // The glyph is the button's whole identity, so it stays drawn in every state:
  // a refetch runs on a cold launch and on every foreground return, and a busy
  // button that swapped the glyph for a spinner left an empty square with a
  // stray indicator dot in one cell of the design gate. The tap spins the same
  // glyph instead, so the busy response is visible without hiding the control.
  const rotation = useSharedValue(0);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  function handleRefresh() {
    rotation.value = 0;
    rotation.value = withTiming(360, {
      duration: REFRESH_SPIN_MS,
      easing: Easing.inOut(Easing.cubic),
    });
    onRefreshInstances();
  }

  const targetLabel =
    runOnInstance !== null ? `${runOnInstance.name} · ${runOnInstance.projectName}` : null;
  if (showRunOnSelector) {
    return (
      <View className="mt-5">
        <Text className="mb-2 text-sm font-medium text-muted-foreground">
          {t('agentChat.instancePicker.runOn')}
        </Text>
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <InstanceSelector
              value={runOnInstance}
              instances={instanceList}
              isLoading={isLoadingInstances}
              pendingComputer={pendingComputer}
              onChange={onChangeRunOnInstance}
              disabled={disabled}
            />
          </View>
          <Button
            variant="outline"
            size="icon"
            onPress={handleRefresh}
            disabled={disabled}
            // A refetch in flight is not a disabled state: the button keeps the
            // glyph at full foreground ink and stays pressable, and the tap
            // animates the same glyph. Disabling it would dim the only mark it
            // has (Button dims a disabled non-primary control to half opacity).
            accessibilityState={{ busy: isFetchingInstances }}
            accessibilityLabel={t('common.refresh')}
          >
            <Animated.View style={spinStyle}>
              <RefreshCw size={18} color={colors.foreground} />
            </Animated.View>
          </Button>
        </View>
      </View>
    );
  }
  if (targetLabel === null) {
    return null;
  }
  return (
    <View className="mt-2">
      <Text className="text-sm text-muted-foreground">
        {t('agentChat.newSession.runOnWithTarget', { target: targetLabel })}
      </Text>
    </View>
  );
}
