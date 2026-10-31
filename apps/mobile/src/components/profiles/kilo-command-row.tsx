import { sessionLiveText } from '@kilocode/session-ingest-contracts';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { InlineBadge } from '@/components/ui/inline-badge';
import { ProfileSwitch } from '@/components/profiles/profile-switch';
import { ChevronDown, ChevronUp, Pencil, Terminal, Trash2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { COMPACT_CONTROL_BOX_CLASS, COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
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
 * One slash command row: the `/name`, optional subtask/agent/model metadata and
 * the template preview, then one control row that spans the card: the enabled
 * switch on the leading edge, the up/down and edit/delete actions on the
 * trailing edge. The row carries no container `accessibilityLabel`, and the
 * visible `/name` is hidden from assistive technology, so the switch carries
 * that same visible name as the row's single accessible one.
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
  // The slash form is the command's visible name; the row renders it once and
  // hands it to the switch when the visible copy leaves the accessibility tree.
  const visibleName = `/${name}`;
  const controlClass = (disabled: boolean) =>
    cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70', disabled && 'opacity-40');
  return (
    <View className="gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="min-w-0 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <Terminal size={16} color={colors.mutedForeground} />
          <Text variant="mono" className="text-sm" numberOfLines={1} {...HIDDEN_LABEL_PROPS}>
            {visibleName}
          </Text>
          {subtask ? <InlineBadge>{t('profiles.slashCommands.subtask')}</InlineBadge> : null}
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
      <View className="flex-row items-center justify-between gap-2">
        <ProfileSwitch
          value={enabled}
          // The only element carrying the row's name, so it takes the visible
          // form: a screen reader hears the command as the slash command it is.
          accessibilityLabel={visibleName}
          disabled={onToggle === undefined}
          onValueChange={onToggle}
        />
        <View className="flex-row items-center gap-1">
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
      </View>
    </View>
  );
}
