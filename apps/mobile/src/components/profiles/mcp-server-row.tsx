import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { type McpServerSource } from '@/components/profiles/profile-mcp-model';
import { Lock, Pencil, Server, Trash2 } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { ICON_TARGET_BOX_CLASS, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type McpServerRowProps = Readonly<{
  server: McpServerSource;
  summary: string;
  secretCount: number;
  onToggle?: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}>;

/**
 * One MCP server row: the name in mono, its type and key count on the line under
 * it, the command/URL summary, the enabled switch and the edit/delete controls.
 * The name owns its line, so it is ellipsized only when it alone is wider than the
 * row; the type and the count are metadata and never take the room a short name
 * needs. The name is painted only and hidden from assistive technology, so the
 * switch's label stays the only element a screen reader matches by the server's
 * name; the type, summary and key count keep their own stops because they say what
 * the name does not. It lives in a `RowGroup`, which draws the separator.
 */
export function McpServerRowView({
  server,
  summary,
  secretCount,
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
  return (
    <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}>
      <IconTile icon={Server} tint={NEUTRAL_TINT} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="mono" numberOfLines={1} {...HIDDEN_LABEL_PROPS} className="min-w-0 shrink">
          {server.name}
        </Text>
        <View className="flex-row items-center gap-2">
          <Text variant="caption">{typeLabel}</Text>
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
        {summary.length > 0 ? (
          <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
      </View>
      <Switch
        value={server.enabled}
        accessibilityLabel={server.name}
        disabled={onToggle === undefined}
        onValueChange={onToggle}
      />
      {onEdit !== undefined ? (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.mcp.edit', { name: server.name })}
          onPress={onEdit}
        >
          <Pencil size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
      {onDelete !== undefined ? (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.mcp.delete', { name: server.name })}
          onPress={onDelete}
        >
          <Trash2 size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}
