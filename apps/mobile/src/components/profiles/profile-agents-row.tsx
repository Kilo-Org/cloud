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
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
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
 * screen reader hears what the row is before the controls that change it.
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
  // The name owns its row, so an agent name is ellipsized only when it alone is
  // wider than the card; the mode label never takes the room a short name needs.
  // The label is metadata, so it leads the column under the name at the same
  // 2 dp gap the card uses between its meta lines.
  return (
    <View className="min-h-16 flex-row items-start gap-1 rounded-lg bg-secondary px-3 py-2">
      <ProfileRowIdentity label={profileRowLabel(name, visibilityLabel, model, description)}>
        <View className="flex-row items-center gap-2">
          <Bot size={16} color={colors.mutedForeground} />
          <Text className="min-w-0 shrink text-sm font-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
        </View>
        <Text className="text-xs uppercase tracking-wide text-muted-foreground">
          {visibilityLabel}
        </Text>
        {model.length > 0 ? (
          <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
            {model}
          </Text>
        ) : null}
        {description.length > 0 ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
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
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-16 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}
