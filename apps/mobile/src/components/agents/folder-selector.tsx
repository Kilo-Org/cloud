import { type Href, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from '@/components/ui/icons';

import { Text } from '@/components/ui/text';
import { stripInlineCodeMarkers } from '@/i18n/plain-copy';
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

function FolderSelector({
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
      <Text className="flex-1 text-base text-foreground" numberOfLines={1} ellipsizeMode="middle">
        {label}
      </Text>
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}

/**
 * Labeled "Folder" field: the field title plus the chrome selector. Lives in
 * this module so the configure form stays under its line limit.
 *
 * `runOnInstance` is null for the tour's computer target with no connected
 * computer yet: the Folder row renders the setup hint instead of the picker
 * control, since there is no connection to list folders on.
 */
export function LaunchFolderField({
  folderPath,
  runOnInstance,
  onChangeFolderPath,
  disabled,
}: {
  folderPath: string;
  runOnInstance: InstancePickerInstance | null;
  onChangeFolderPath: (path: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  if (runOnInstance === null) {
    // The tour's computer target with no connected computer yet: keep the
    // remote surface's Folder row but inert, since there is no connection to
    // list folders on. The setup hint under Start names the recovery.
    return (
      <View className="mt-5">
        <Text className="mb-2 text-sm font-medium text-muted-foreground">
          {t('agentChat.folderPicker.fieldLabel')}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {stripInlineCodeMarkers(t('agentChat.instancePicker.noCliInstancesDescription'))}
        </Text>
      </View>
    );
  }
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
