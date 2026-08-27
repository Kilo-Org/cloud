import { type Href, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from '@/components/ui/icons';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { folderPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

type FolderSelectorProps = {
  /** Relative path the picker confirmed, or `""` for the launch directory. */
  folderPath: string;
  /** The selected instance's project, shown when `folderPath` is `""`. */
  projectName: string;
  runOnInstance: InstancePickerInstance;
  onChangeFolderPath: (path: string) => void;
  disabled?: boolean;
};

export function FolderSelector({
  folderPath,
  projectName,
  runOnInstance,
  onChangeFolderPath,
  disabled = false,
}: Readonly<FolderSelectorProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();

  const label = folderPath === '' ? projectName : folderPath;

  function handlePress() {
    if (disabled) {
      return;
    }
    folderPickerSlot.set(UNFENCED_ROUTE_KEY, {
      connectionId: runOnInstance.connectionId,
      projectName,
      currentPath: folderPath,
      onSelect: onChangeFolderPath,
    });
    router.push('/(app)/agent-chat/folder-picker' as Href);
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.folderPicker.accessibility', { label })}
      accessibilityState={{ disabled }}
      className={cn(
        'flex-row items-center justify-between rounded-lg border border-border bg-secondary px-3 py-3',
        disabled && 'opacity-50'
      )}
    >
      <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}

/**
 * Labeled "Folder" field: the field title plus the chrome selector. Lives in
 * this module so the configure form stays under its line limit.
 */
export function LaunchFolderField({
  folderPath,
  runOnInstance,
  onChangeFolderPath,
  disabled,
}: {
  folderPath: string;
  runOnInstance: InstancePickerInstance;
  onChangeFolderPath: (path: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.folderPicker.fieldLabel')}
      </Text>
      <FolderSelector
        folderPath={folderPath}
        projectName={runOnInstance.projectName}
        runOnInstance={runOnInstance}
        onChangeFolderPath={onChangeFolderPath}
        disabled={disabled}
      />
    </View>
  );
}
