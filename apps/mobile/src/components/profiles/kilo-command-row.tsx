import { sessionLiveText } from '@kilocode/session-ingest-contracts';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ReorderableItem, ReorderableItemActions } from '@/components/profiles/reorderable-item';
import { Eyebrow } from '@/components/ui/eyebrow';
import { IconTile } from '@/components/ui/icon-tile';
import { Terminal } from '@/components/ui/icons';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';

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
  const preview = useMemo(() => templatePreview(template), [template]);
  const visibleName = `/${name}`;
  return (
    <ReorderableItem
      actions={
        <ReorderableItemActions
          moveUp={
            onMoveUp === undefined
              ? undefined
              : {
                  label: t('profiles.slashCommands.moveUp', { name }),
                  disabled: isFirst,
                  onPress: onMoveUp,
                }
          }
          moveDown={
            onMoveDown === undefined
              ? undefined
              : {
                  label: t('profiles.slashCommands.moveDown', { name }),
                  disabled: isLast,
                  onPress: onMoveDown,
                }
          }
          edit={
            onEdit === undefined
              ? undefined
              : { label: t('profiles.slashCommands.edit', { name }), onPress: onEdit }
          }
          remove={
            onDelete === undefined
              ? undefined
              : { label: t('profiles.slashCommands.delete', { name }), onPress: onDelete }
          }
        />
      }
    >
      <View className="flex-row items-center gap-3">
        <IconTile icon={Terminal} tint={NEUTRAL_TINT} />
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text variant="mono" className="text-sm" numberOfLines={1} {...HIDDEN_LABEL_PROPS}>
              {visibleName}
            </Text>
            {subtask ? (
              <Eyebrow className="rounded-md border border-border px-1.5 py-0.5">
                {t('profiles.slashCommands.subtask')}
              </Eyebrow>
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
        <View className="shrink-0">
          {renderRowTrailing({
            kind: 'switch',
            value: enabled,
            // The row's only element carrying the name, so it takes the visible
            // form: the announced name matches the label on screen.
            accessibilityLabel: visibleName,
            disabled: onToggle === undefined,
            onValueChange: next => {
              onToggle?.(next);
            },
          })}
        </View>
      </View>
    </ReorderableItem>
  );
}
