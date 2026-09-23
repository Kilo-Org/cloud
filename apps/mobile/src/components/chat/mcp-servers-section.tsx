import { Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Server } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';

import { type RemoteMcpServerRow } from './mcp-settings-state';

/**
 * The remote MCP servers section of the chat-tools sheet.
 *
 * One row per server the person added: what it is, what it answered, the switch
 * that turns it on for the chats, and the edit and delete controls. The empty
 * state and the Add button belong to the section, so a list that is being
 * checked never loses the way to add one.
 *
 * The Kilo server is not drawn here: it is the build's own, so it offers
 * neither an edit nor a delete.
 */

type McpServersSectionProps = {
  readonly servers: readonly RemoteMcpServerRow[];
  readonly onToggle: (id: string, next: boolean) => void;
  readonly onEdit: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onAdd: () => void;
};

export function McpServersSection({
  servers,
  onToggle,
  onEdit,
  onDelete,
  onAdd,
}: Readonly<McpServersSectionProps>) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-semibold uppercase text-muted-foreground">
        {t('modelChat.mcp.serversSection')}
      </Text>
      {servers.length === 0 ? (
        <EmptyState
          icon={Server}
          title={t('modelChat.mcp.serversEmptyTitle')}
          description={t('modelChat.mcp.serversEmptyDescription')}
          placement="top"
          className="px-0 pt-0"
        />
      ) : (
        servers.map(row => (
          <McpServerRow
            key={row.id}
            row={row}
            onToggle={next => {
              onToggle(row.id, next);
            }}
            onEdit={() => {
              onEdit(row.id);
            }}
            onDelete={() => {
              onDelete(row.id);
            }}
          />
        ))
      )}
      <Button variant="secondary" onPress={onAdd}>
        <Text>{t('modelChat.mcp.addServer')}</Text>
      </Button>
    </View>
  );
}

type McpServerRowProps = {
  readonly row: RemoteMcpServerRow;
  readonly onToggle: (next: boolean) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
};

/** One remote server: what it is, what it answered, and what may be done to it. */
function McpServerRow({ row, onToggle, onEdit, onDelete }: Readonly<McpServerRowProps>) {
  const { t } = useTranslation();
  return (
    <View className="gap-2 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {row.name}
          </Text>
          <Text variant="muted" className="mt-0.5 text-xs" numberOfLines={1}>
            {row.url}
          </Text>
        </View>
        <Switch
          value={row.enabled}
          accessibilityLabel={t('modelChat.mcp.enableServer')}
          onValueChange={onToggle}
        />
      </View>
      {/* One line's height in every state, so checking -> tools -> unreachable
          never moves the controls under it. */}
      <View className="min-h-6 justify-center">
        <Text variant="muted" className="text-xs">
          {t(row.statusKey, { count: row.toolCount })}
        </Text>
      </View>
      <View className="flex-row gap-2">
        <Button variant="secondary" size="sm" onPress={onEdit}>
          <Text>{t('modelChat.mcp.editServer')}</Text>
        </Button>
        <Button variant="secondary" size="sm" onPress={onDelete}>
          <Text>{t('modelChat.mcp.deleteServer')}</Text>
        </Button>
      </View>
    </View>
  );
}
