import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { repoPlatformBadge, repoPlatformLabelKey } from '@/components/profiles/repo-bindings-model';
import { ProfileRowIdentity, profileRowLabel } from '@/components/profiles/profile-row-identity';
import { Eyebrow } from '@/components/ui/eyebrow';
import { ChevronDown, GitBranch, Trash2 } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  FIELD_TRIGGER_BODY_CLASS,
  FIELD_TRIGGER_FRAME_CLASS,
  ICON_TARGET_BOX_CLASS,
  ROW_TARGET_CLASS,
} from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Content-shaped rows in the same slot and height as a loaded binding row, so
 * the swap from skeleton to bindings does not move the Add control below it.
 */
export function RepoBindingsSkeleton() {
  return (
    <RowGroup>
      {[0, 1, 2].map(index => (
        <RowSkeleton key={index} tile subtitle trailingControl />
      ))}
    </RowGroup>
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
    <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}>
      <IconTile icon={GitBranch} tint={NEUTRAL_TINT} />
      {/* One identity element, first, in reading order: the row is announced as
          "repository, profile, provider" before the control that removes it. The
          badge repeats the provider, so it stays out of the accessibility tree. */}
      <ProfileRowIdentity label={profileRowLabel(repoFullName, profileName, providerLabel)}>
        <Text variant="mono" className="text-sm" numberOfLines={1}>
          {repoFullName}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {profileName}
        </Text>
      </ProfileRowIdentity>
      <Eyebrow
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="rounded-md border border-border px-1.5 py-0.5"
      >
        {repoPlatformBadge(platform)}
      </Eyebrow>
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
  hint,
  reserveHint,
  accessibilityLabel,
  disabled,
  onPress,
}: Readonly<{
  label: string;
  value: string | null;
  /** The line under the field right now, or null when it has nothing to say. */
  hint: string | null;
  /**
   * The copy the hint line reserves, so the action row under the form does not
   * move when a hint appears. Null reserves nothing, for a field that never has
   * one.
   */
  reserveHint: string | null;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}>) {
  const colors = useThemeColors();
  return (
    <View className="gap-1.5">
      <Pressable
        className={cn(
          ROW_TARGET_CLASS,
          FIELD_TRIGGER_FRAME_CLASS,
          'active:opacity-70',
          disabled && 'opacity-70'
        )}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
      >
        <View className={FIELD_TRIGGER_BODY_CLASS}>
          <Text
            className={
              value === null ? 'min-w-0 flex-1 text-sm text-muted-foreground' : 'min-w-0 flex-1 text-sm text-foreground'
            }
            numberOfLines={1}
          >
            {value ?? label}
          </Text>
          <ChevronDown size={16} color={colors.mutedForeground} />
        </View>
      </Pressable>
      {reserveHint === null ? null : (
        <View>
          {/* Full-width, invisible copy reserves the hint's wrapped height at the
              current width before there is anything to say, so showing it cannot
              push the buttons below it down. Same recipe as `FormField`. */}
          <View
            className="flex-row opacity-0"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text className="w-full shrink-0 text-xs">{reserveHint}</Text>
          </View>
          {hint === null ? null : (
            <View className="absolute inset-x-0 top-0">
              <Text variant="caption" className="text-destructive">
                {hint}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
