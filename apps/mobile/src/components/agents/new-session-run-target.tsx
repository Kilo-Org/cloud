import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

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
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
  onRefreshInstances: () => void;
  disabled: boolean;
};

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
  onChangeRunOnInstance,
  onRefreshInstances,
  disabled,
}: Readonly<NewSessionRunTargetProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
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
              onChange={onChangeRunOnInstance}
              disabled={disabled}
            />
          </View>
          <Button
            variant="outline"
            size="icon"
            onPress={onRefreshInstances}
            disabled={disabled || isFetchingInstances}
            loading={isFetchingInstances}
            accessibilityLabel={t('common.refresh')}
          >
            {!isFetchingInstances ? <RefreshCw size={18} color={colors.foreground} /> : null}
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
