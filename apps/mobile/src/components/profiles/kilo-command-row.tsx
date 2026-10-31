import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { ChevronDown, ChevronUp, Pencil, Terminal, Trash2 } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { cn } from '@/lib/utils';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';

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
  onToggle?: (enabled: boolean) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}>;

/**
 * One slash command row: the `/name`, optional subtask/agent/model metadata, the
 * template preview, the enabled switch, and up/down/edit/delete controls. The
 * row carries no container `accessibilityLabel`, and the visible `/name` is
 * hidden from assistive technology, so the switch carries that same visible name
 * as the row's single accessible one.
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
  // The slash form is the command's visible name; the row renders it once and
  // hands it to the switch when the visible copy leaves the accessibility tree.
  const visibleName = `/${name}`;
  const controlClass = (disabled: boolean) =>
    cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70', disabled && 'opacity-40');
  return (
    <View className="gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="flex-row items-center gap-1">
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-center gap-2">
            <Terminal size={16} color={colors.mutedForeground} />
            <Text variant="mono" className="text-sm" numberOfLines={1} {...HIDDEN_LABEL_PROPS}>
              {visibleName}
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
              {[agent.length > 0 ? `${t('common.agent')}: ${agent}` : '', model]
                .filter(Boolean)
                .join('  ')}
            </Text>
          ) : null}
        </View>
        <Switch
          value={enabled}
          // The only element carrying the row's name, so it takes the visible
          // form: a screen reader hears the command as the slash command it is.
          accessibilityLabel={visibleName}
          disabled={onToggle === undefined}
          onValueChange={onToggle}
        />
      </View>
      {onMoveUp !== undefined ||
      onMoveDown !== undefined ||
      onEdit !== undefined ||
      onDelete !== undefined ? (
        <View className="flex-row items-center justify-end gap-1">
          {onMoveUp !== undefined ? (
            <Pressable
              className={controlClass(isFirst)}
              disabled={isFirst}
              accessibilityRole="button"
              accessibilityLabel={t('profiles.slashCommands.moveUp', { name })}
              onPress={onMoveUp}
            >
              <ChevronUp size={20} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
          {onMoveDown !== undefined ? (
            <Pressable
              className={controlClass(isLast)}
              disabled={isLast}
              accessibilityRole="button"
              accessibilityLabel={t('profiles.slashCommands.moveDown', { name })}
              onPress={onMoveDown}
            >
              <ChevronDown size={20} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
          {onEdit !== undefined ? (
            <Pressable
              className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
              accessibilityRole="button"
              accessibilityLabel={t('profiles.slashCommands.edit', { name })}
              onPress={onEdit}
            >
              <Pencil size={18} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
          {onDelete !== undefined ? (
            <Pressable
              className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
              accessibilityRole="button"
              accessibilityLabel={t('profiles.slashCommands.delete', { name })}
              onPress={onDelete}
            >
              <Trash2 size={18} color={colors.destructive} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
