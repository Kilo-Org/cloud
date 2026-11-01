import { sessionLiveText } from '@kilocode/session-ingest-contracts';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, useColorScheme, View } from 'react-native';

import { ChevronDown, ChevronUp, Pencil, Terminal, Trash2 } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { COMPACT_CONTROL_BOX_CLASS, COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';

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
 * The longest preview the row draws and reads: one clipped line of the template.
 * A trailing ellipsis counts inside it.
 */
const TEMPLATE_PREVIEW_LIMIT = 40;

/** Where a template's first line ends: the platform's line breaks. */
const TEMPLATE_LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * The template's first line, bounded for the row's preview.
 *
 * `numberOfLines={1}` clips only the drawing: the native text view still holds
 * the whole stored template (up to 100,000 characters), so an Android screen
 * reader read a multi-KB command body before the controls that follow it. The
 * bounded string is the entire text the row draws, and Android reads a text view
 * without an `accessibilityLabel` from that same string, so what is read out is
 * what is shown and the template never reaches the native view whole.
 * `sessionLiveText` cuts on a character boundary and drops format controls, which
 * a template pasted from a document can carry.
 */
function templatePreview(template: string): string | null {
  const lineBreak = template.search(TEMPLATE_LINE_BREAK);
  return sessionLiveText(
    lineBreak === -1 ? template : template.slice(0, lineBreak),
    TEMPLATE_PREVIEW_LIMIT
  );
}

/**
 * One slash command row: the `/name`, optional subtask/agent/model metadata, the
 * template preview, the enabled switch, and up/down/edit/delete controls. The
 * row carries no container `accessibilityLabel`; the visible `/name` is painted
 * only and the switch carries that same visible form, so the switch's label is
 * the single element a screen reader matches by the command's name.
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
  const preview = useMemo(() => templatePreview(template), [template]);
  // Same signal `useThemeColors` reads. The dark palette's `primaryForeground`
  // is near-black, so an off switch drawn from it put a dark thumb on a dark
  // track over the dark card; the off state asks for a light thumb on a track
  // that stands off the card in both schemes.
  const isDark = useColorScheme() === 'dark';
  const offTrackColor = isDark ? colors.mutedForeground : colors.mutedSoft;
  const offThumbColor = isDark ? colors.foreground : colors.primaryForeground;
  const controlClass = (disabled: boolean) =>
    cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70', disabled && 'opacity-40');
  const visibleName = `/${name}`;
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
          {preview === null ? null : (
            <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
              {preview}
            </Text>
          )}
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
          // The row's only element carrying the name, so it takes the visible
          // form: the announced name matches the label on screen.
          accessibilityLabel={visibleName}
          disabled={onToggle === undefined}
          onValueChange={onToggle}
          trackColor={{ false: offTrackColor, true: colors.primary }}
          thumbColor={enabled ? colors.primaryForeground : offThumbColor}
        />
      </View>
      {onMoveUp !== undefined ||
      onMoveDown !== undefined ||
      onEdit !== undefined ||
      onDelete !== undefined ? (
        <View className="flex-row items-center justify-end gap-5">
          {onMoveUp !== undefined ? (
            <Pressable
              className={controlClass(isFirst)}
              disabled={isFirst}
              accessibilityRole="button"
              accessibilityLabel={t('profiles.slashCommands.moveUp', { name })}
              hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
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
              hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
              onPress={onMoveDown}
            >
              <ChevronDown size={20} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
          {onEdit !== undefined ? (
            <Pressable
              className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70')}
              accessibilityRole="button"
              accessibilityLabel={t('profiles.slashCommands.edit', { name })}
              hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
              onPress={onEdit}
            >
              <Pencil size={18} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
          {onDelete !== undefined ? (
            <Pressable
              className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70')}
              accessibilityRole="button"
              accessibilityLabel={t('profiles.slashCommands.delete', { name })}
              hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
              onPress={onDelete}
            >
              <Trash2 size={18} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
