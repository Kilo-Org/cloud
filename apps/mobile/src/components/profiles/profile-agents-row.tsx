/**
 * The profile agents screen's list row and skeleton. The screen file renders
 * the list and its mutations; these parts draw one row, so the screen stays
 * under the file-size bound without losing the row's comments or tests.
 */

import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  AGENT_VISIBILITY_LABEL_KEYS,
  type AgentVisibility,
} from '@/components/profiles/profile-agents-model';
import { ProfileRowIdentity, profileRowLabel } from '@/components/profiles/profile-row-identity';
import { Bot, Pencil, Trash2 } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { ICON_TARGET_BOX_CLASS, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type AgentRowViewProps = Readonly<{
  name: string;
  visibility: AgentVisibility;
  description: string;
  model: string;
  onEdit?: () => void;
  onDelete?: () => void;
}>;

/**
 * One agent row: name, visibility, optional model and description, edit/delete.
 * The name and what qualifies it are one identity element declared first, so a
 * screen reader hears what the row is before the controls that change it. It
 * lives in a `RowGroup`, which draws the separator between rows.
 */
export function AgentRowView({
  name,
  visibility,
  description,
  model,
  onEdit,
  onDelete,
}: AgentRowViewProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const visibilityLabel = t(AGENT_VISIBILITY_LABEL_KEYS[visibility]);
  // The name owns its line, so an agent name is ellipsized only when it alone is
  // wider than the row; the mode label is metadata and never takes the room a
  // short name needs.
  return (
    <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}>
      <IconTile icon={Bot} tint={NEUTRAL_TINT} />
      <ProfileRowIdentity label={profileRowLabel(name, visibilityLabel, model, description)}>
        <Text className="min-w-0 shrink text-sm font-medium text-foreground" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="caption">{visibilityLabel}</Text>
        {model.length > 0 ? (
          <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
            {model}
          </Text>
        ) : null}
        {description.length > 0 ? (
          <Text variant="caption" numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </ProfileRowIdentity>
      {onEdit !== undefined ? (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.agents.edit', { name })}
          onPress={onEdit}
        >
          <Pencil size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
      {onDelete !== undefined ? (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.agents.delete', { name })}
          onPress={onDelete}
        >
          <Trash2 size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Content-shaped rows in the same slots as a loaded agent row. */
export function AgentsSkeleton() {
  return (
    <RowGroup>
      {[0, 1, 2].map(index => (
        <RowSkeleton key={index} tile subtitle />
      ))}
    </RowGroup>
  );
}
