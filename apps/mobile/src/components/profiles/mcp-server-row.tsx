import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { type McpServerSource } from '@/components/profiles/profile-mcp-model';
import { Lock, Pencil, Trash2 } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
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
 * card; the type and the count are metadata and never take the room a short name
 * needs. The name is painted only and hidden from assistive technology, so the
 * switch's label stays the only element a screen reader matches by the server's
 * name; the type, summary and key count keep their own stops because they say what
 * the name does not.
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
    <View className="min-h-16 flex-row items-center gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="mono" numberOfLines={1} {...HIDDEN_LABEL_PROPS} className="min-w-0 shrink">
          {server.name}
        </Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">{typeLabel}</Text>
          {secretLabel === null ? null : (
            <View className="flex-row items-center gap-0.5">
              <Lock size={12} color={colors.mutedForeground} />
              {/* The count sits beside a lock glyph and a bare number reads as
                  nothing, so the line carries the plural wording as its name
                  while the row keeps the compact digit on screen. */}
              <Text className="text-xs text-muted-foreground" accessibilityLabel={secretLabel}>
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
