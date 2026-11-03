import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { repoPlatformBadge, repoPlatformLabelKey } from '@/components/profiles/repo-bindings-model';
import { ProfileRowIdentity, profileRowLabel } from '@/components/profiles/profile-row-identity';
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

/** One binding row: repo full name, profile name, provider badge, remove. */
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
  const providerLabel = t(repoPlatformLabelKey(platform));
  return (
    <View className="min-h-14 flex-row items-center gap-2 rounded-lg bg-secondary px-3 py-2">
      <GitBranch size={16} color={colors.mutedForeground} />
      {/* One identity element, first, in reading order: the row is announced as
          "repository, profile, provider" before the control that removes it. The
          badge repeats the provider, so it stays out of the accessibility tree. */}
      <ProfileRowIdentity label={profileRowLabel(repoFullName, profileName, providerLabel)}>
        <View className="gap-0.5">
          <Text variant="mono" className="text-sm" numberOfLines={1}>
            {repoFullName}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {profileName}
          </Text>
        </View>
      </ProfileRowIdentity>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
      >
        {repoPlatformBadge(platform)}
      </Text>
      <Pressable
        className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
        accessibilityRole="button"
        accessibilityLabel={t('profiles.repoBindings.removeForRepo', { repo: repoFullName })}
        disabled={isRemoving}
        onPress={onRemove}
      >
        <Trash2 size={18} color={colors.mutedForeground} />
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
