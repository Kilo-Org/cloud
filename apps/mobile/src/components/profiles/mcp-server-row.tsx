import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { type McpServerSource } from '@/components/profiles/profile-mcp-model';
import { ProfileRowIdentity, profileRowLabel } from '@/components/profiles/profile-row-identity';
import { Lock, Pencil, Trash2 } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
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
 * One MCP server row: the name in mono, its type, the command/URL summary and
 * a lock badge with the masked env/header key count, the enabled switch and the
 * edit/delete controls. The name and what qualifies it are one identity element
 * declared first, so a screen reader hears what the row is before the controls
 * that change it.
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
      <ProfileRowIdentity label={profileRowLabel(server.name, typeLabel, summary, secretLabel)}>
        <View className="flex-row items-center gap-2">
          <Text variant="mono" numberOfLines={1} className="shrink">
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
          <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
      </ProfileRowIdentity>
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
