import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { type McpServerSource } from '@/components/profiles/profile-mcp-model';
import { ProfileSwitch } from '@/components/profiles/profile-switch';
import { Lock, Pencil, Trash2 } from '@/components/ui/icons';
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
 * A server row's URL or command line truncates in the middle: its tail is what
 * tells one endpoint apart from another, so the head alone does not carry it.
 */
const SUMMARY_PROPS = { numberOfLines: 1, ellipsizeMode: 'middle' } as const;

/**
 * One MCP server row: the name in mono, its type, the command/URL summary, the
 * enabled switch and a lock badge with the masked env/header key count. The
 * name is hidden from assistive technology, so the switch's label stays the
 * only element a screen reader matches by the server's name; the type, summary
 * and key count keep their own stops because they say what the name does not.
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
  return (
    <View className="min-h-16 flex-row items-center gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text variant="mono" numberOfLines={1} {...HIDDEN_LABEL_PROPS} className="shrink">
            {server.name}
          </Text>
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">{typeLabel}</Text>
          {secretCount > 0 ? (
            <View className="flex-row items-center gap-0.5">
              <Lock size={12} color={colors.mutedForeground} />
              <Text className="text-xs text-muted-foreground">{secretCount}</Text>
            </View>
          ) : null}
        </View>
        {summary.length > 0 ? (
          <Text variant="mono" className="text-xs text-muted-foreground" {...SUMMARY_PROPS}>
            {summary}
          </Text>
        ) : null}
      </View>
      <ProfileSwitch
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
