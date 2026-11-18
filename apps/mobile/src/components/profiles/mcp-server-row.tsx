import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { type McpServerSource } from '@/components/profiles/profile-mcp-model';
import { Lock, Server, Trash2 } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { RowFrame } from '@/components/ui/row-frame';
import { renderRowTrailing, RowIconAction } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type McpServerRowProps = Readonly<{
  server: McpServerSource;
  summary: string;
  secretCount: number;
  /**
   * The list holds both local and remote servers, so the type tells rows apart.
   * When every row is the same type it repeats what the whole list already
   * says, and the row leaves it out.
   */
  showType: boolean;
  onToggle?: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}>;

/**
 * One MCP server row: the name in mono, its type and key count on the line under
 * it, the command/URL summary, the enabled switch and delete. The content is the
 * edit action — the form sheet has no delete of its own — so the row carries two
 * trailing controls instead of three and the sheet opens from the row the reader
 * is already on. It lives in a `RowGroup`, which draws the separator.
 *
 * The name owns its line, so it is ellipsized only when it alone is wider than
 * the row; the type and the count are metadata and never take the room a short
 * name needs. The summary is a value, so it keeps both of its ends and ellipsizes
 * in the middle — a URL or a command is told apart by its tail. The painted lines
 * are hidden from assistive technology, and the content press and the switch are
 * what a reader reaches.
 */
export function McpServerRowView({
  server,
  summary,
  secretCount,
  showType,
  onToggle,
  onEdit,
  onDelete,
}: McpServerRowProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const typeLabel =
    server.type === 'local' ? t('profiles.mcp.localType') : t('profiles.mcp.remoteType');
  const secretLabel =
    secretCount > 0 ? t('profiles.mcp.secretCount', { count: secretCount }) : null;

  const trailing: ReactNode[] = [
    <Fragment key="enable">
      {renderRowTrailing({
        kind: 'switch',
        value: server.enabled,
        accessibilityLabel: server.name,
        disabled: onToggle === undefined,
        onValueChange: next => {
          onToggle?.(next);
        },
      })}
    </Fragment>,
  ];
  if (onDelete !== undefined) {
    trailing.push(
      <RowIconAction
        key="delete"
        label={t('profiles.mcp.delete', { name: server.name })}
        onPress={onDelete}
      >
        <Trash2 size={18} color={colors.mutedForeground} />
      </RowIconAction>
    );
  }

  return (
    <RowFrame
      leading={<IconTile icon={Server} tint={NEUTRAL_TINT} />}
      pressTarget="content"
      onPress={onEdit}
      contentAccessibilityLabel={
        onEdit === undefined ? undefined : t('profiles.mcp.edit', { name: server.name })
      }
      disabled={onEdit === undefined}
      trailing={{ kind: 'nodes', nodes: trailing }}
    >
      <Text variant="mono" numberOfLines={1} {...HIDDEN_LABEL_PROPS} className="min-w-0 shrink">
        {server.name}
      </Text>
      {showType || secretLabel !== null ? (
        <View className="mt-0.5 flex-row items-center gap-2">
          {showType ? <Text variant="caption">{typeLabel}</Text> : null}
          {secretLabel === null ? null : (
            <View className="flex-row items-center gap-0.5">
              <Lock size={12} color={colors.mutedForeground} />
              {/* The count sits beside a lock glyph and a bare number reads as
                  nothing, so the line carries the plural wording as its name
                  while the row keeps the compact digit on screen. */}
              <Text variant="caption" accessibilityLabel={secretLabel}>
                {secretCount}
              </Text>
            </View>
          )}
        </View>
      ) : null}
      {summary.length > 0 ? (
        <Text
          variant="mono"
          className="mt-0.5 text-xs text-muted-foreground"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {summary}
        </Text>
      ) : null}
    </RowFrame>
  );
}
