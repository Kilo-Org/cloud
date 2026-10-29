import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { repoPlatformBadge } from '@/components/profiles/repo-bindings-model';
import { ChevronDown, GitBranch, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { ICON_TARGET_BOX_CLASS, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Content-shaped rows in the same slot and height as a loaded binding row, so
 * the swap from skeleton to bindings does not move the Add control below it.
 */
export function RepoBindingsSkeleton() {
  return (
    <View className="gap-2">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-14 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}

/** One binding row: repo full name, provider badge, profile name, remove. */
export function RepoBindingRow({
  repoFullName,
  platform,
  profileName,
  isRemoving,
  onRemove,
}: Readonly<{
  repoFullName: string;
  platform: string;
  profileName: string;
  isRemoving: boolean;
  onRemove: () => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="min-h-14 flex-row items-center gap-2 rounded-lg bg-secondary px-3 py-2">
      <GitBranch size={16} color={colors.mutedForeground} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="mono" className="text-sm" numberOfLines={1}>
          {repoFullName}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {profileName}
        </Text>
      </View>
      <Text className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {repoPlatformBadge(platform)}
      </Text>
      <Pressable
        className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
        accessibilityRole="button"
        accessibilityLabel={t('profiles.repoBindings.remove')}
        disabled={isRemoving}
        onPress={onRemove}
      >
        <Trash2 size={18} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

/** A tappable field row that opens one of the Add form's pickers. */
export function PickerField({
  label,
  value,
  accessibilityLabel,
  disabled,
  onPress,
}: Readonly<{
  label: string;
  value: string | null;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}>) {
  const colors = useThemeColors();
  return (
    <Pressable
      className={`${ROW_TARGET_CLASS} flex-row items-center justify-between gap-2 rounded-md border border-border bg-secondary px-3 py-2 active:opacity-70`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
    >
      <Text
        className={value === null ? 'text-sm text-muted-foreground' : 'text-sm text-foreground'}
        numberOfLines={1}
      >
        {value ?? label}
      </Text>
      <ChevronDown size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}
