import { useTranslation } from 'react-i18next';
import { Pressable, Switch, View } from 'react-native';

import { ChevronDown, ChevronUp, Pencil, Terminal, Trash2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type KiloCommandRowProps = Readonly<{
  name: string;
  description: string;
  template: string;
  subtask: boolean;
  agent: string;
  model: string;
  enabled: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggle: (enabled: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}>;

/**
 * One slash command row: the `/name`, optional subtask/agent/model metadata, the
 * template preview, the enabled switch, and up/down/edit/delete controls. The
 * row carries no container `accessibilityLabel`, so the switch's label stays the
 * only element a screen reader matches by the command's name.
 */
export function KiloCommandRowView({
  name,
  description,
  template,
  subtask,
  agent,
  model,
  enabled,
  isFirst,
  isLast,
  onToggle,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: KiloCommandRowProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const controlClass = (disabled: boolean) =>
    cn('h-11 w-11 items-center justify-center active:opacity-70', disabled && 'opacity-40');
  return (
    <View className="gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="flex-row items-center gap-1">
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-center gap-2">
            <Terminal size={16} color={colors.mutedForeground} />
            <Text variant="mono" className="text-sm" numberOfLines={1}>
              {`/${name}`}
            </Text>
            {subtask ? (
              <Text className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('profiles.slashCommands.subtask')}
              </Text>
            ) : null}
          </View>
          {description.length > 0 ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={2}>
              {description}
            </Text>
          ) : null}
          <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
            {template}
          </Text>
          {agent.length > 0 || model.length > 0 ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {[agent.length > 0 ? `${t('profiles.slashCommands.agent')}: ${agent}` : '', model]
                .filter(Boolean)
                .join('  ')}
            </Text>
          ) : null}
        </View>
        <Text className="text-xs text-muted-foreground">
          {enabled ? t('common.enabled') : t('common.disabled')}
        </Text>
        <Switch value={enabled} accessibilityLabel={name} onValueChange={onToggle} />
      </View>
      <View className="flex-row items-center justify-end gap-1">
        <Pressable
          className={controlClass(isFirst)}
          disabled={isFirst}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.moveUp')}
          onPress={onMoveUp}
        >
          <ChevronUp size={20} color={colors.mutedForeground} />
        </Pressable>
        <Pressable
          className={controlClass(isLast)}
          disabled={isLast}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.moveDown')}
          onPress={onMoveDown}
        >
          <ChevronDown size={20} color={colors.mutedForeground} />
        </Pressable>
        <Pressable
          className="h-11 w-11 items-center justify-center active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t('profiles.slashCommands.edit')}
          onPress={onEdit}
        >
          <Pencil size={18} color={colors.mutedForeground} />
        </Pressable>
        <Pressable
          className="h-11 w-11 items-center justify-center active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t('common.delete')}
          onPress={onDelete}
        >
          <Trash2 size={18} color={colors.destructive} />
        </Pressable>
      </View>
    </View>
  );
}
