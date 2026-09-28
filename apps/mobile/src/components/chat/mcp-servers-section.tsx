import { type ReactNode } from 'react';
import { Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Server } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';

import { type RemoteMcpServerRow } from './mcp-settings-state';

/**
 * The remote MCP servers section of the chat-tools sheet.
 *
 * One row per server the person added: what it is, what it answered, the switch
 * that turns it on for the chats, the edit and delete controls, and a Retry
 * when the server could not be reached. The empty state and the Add button
 * belong to the section, so a list that is being checked never loses the way to
 * add one.
 *
 * The list is only empty once it has been read. Until the store answers, the
 * section draws one row-shaped skeleton in the space the list will take, so a
 * returning user's saved servers do not flash as "none" and the Add button
 * below does not jump when the list arrives.
 *
 * The Kilo server is not drawn here: it is the build's own, so it offers
 * neither an edit nor a delete.
 */

type McpServersSectionProps = {
  /** Whether the stored list has been read, so an empty list means none. */
  readonly loaded: boolean;
  readonly servers: readonly RemoteMcpServerRow[];
  /** The servers whose Retry is in flight, so only those buttons show it. */
  readonly retryingIds: readonly string[];
  readonly onToggle: (id: string, next: boolean) => void;
  readonly onEdit: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onRetry: (id: string) => void;
  readonly onAdd: () => void;
};

export function McpServersSection({
  loaded,
  servers,
  retryingIds,
  onToggle,
  onEdit,
  onDelete,
  onRetry,
  onAdd,
}: Readonly<McpServersSectionProps>) {
  const { t } = useTranslation();
  let list: ReactNode = null;
  if (!loaded) {
    // The list has not been read, so its emptiness is not known: draw the shape
    // the rows will take rather than claiming there are none.
    list = <McpServerRowSkeleton />;
  } else if (servers.length === 0) {
    list = (
      <EmptyState
        icon={Server}
        title={t('modelChat.mcp.serversEmptyTitle')}
        description={t('modelChat.mcp.serversEmptyDescription')}
        placement="top"
        className="px-0 pt-0"
      />
    );
  } else {
    list = servers.map(row => (
      <McpServerRow
        key={row.id}
        row={row}
        retrying={retryingIds.includes(row.id)}
        onToggle={next => {
          onToggle(row.id, next);
        }}
        onEdit={() => {
          onEdit(row.id);
        }}
        onDelete={() => {
          onDelete(row.id);
        }}
        onRetry={() => {
          onRetry(row.id);
        }}
      />
    ));
  }
  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-semibold uppercase text-muted-foreground">
        {t('profiles.mcp.title')}
      </Text>
      {list}
      <Button variant="secondary" onPress={onAdd}>
        <Text>{t('profiles.mcp.add')}</Text>
      </Button>
    </View>
  );
}

/**
 * The row's shape before the list is read.
 *
 * The same card, the same three bands and the same heights as `McpServerRow`:
 * a name-and-URL block, the one-line status, and the button row. It is a
 * placeholder for the list, not a second spinner, so it is drawn once and
 * nothing else is stacked on it.
 */
function McpServerRowSkeleton() {
  return (
    <View className="gap-2 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1">
          <Skeleton className="h-5 w-1/2 rounded-md" />
          <Skeleton className="mt-0.5 h-4 w-2/3 rounded-md" />
        </View>
      </View>
      <View className="min-h-6 justify-center">
        <Skeleton className="h-4 w-1/3 rounded-md" />
      </View>
      <View className="flex-row gap-2">
        <Skeleton className="h-9 w-20 rounded-md" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </View>
    </View>
  );
}

type McpServerRowProps = {
  readonly row: RemoteMcpServerRow;
  /** This row's Retry is in flight, so its button shows it is working. */
  readonly retrying: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onRetry: () => void;
};

/** One remote server: what it is, what it answered, and what may be done to it. */
function McpServerRow({
  row,
  retrying,
  onToggle,
  onEdit,
  onDelete,
  onRetry,
}: Readonly<McpServerRowProps>) {
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
          accessibilityLabel={t('modelChat.mcp.enableServer', { name: row.name })}
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
      {/* Retry joins the controls that are always here, so a row that failed
          grows no taller and a row that recovers shrinks no shorter. It stays
          while this row's ask is in flight, even if discovery has already left
          failed, so the busy state is this button and not a second spinner.
          Every control here and above names its server: the row's name is drawn
          beside them, and a screen reader swiping the list otherwise hears the
          same "Enable this server", "Edit server", "Delete server" once per
          server and cannot tell which one it is on. */}
      <View className="flex-row gap-2">
        {row.retry || retrying ? (
          <Button
            key={retrying ? 'retrying' : 'idle'}
            variant="secondary"
            size="sm"
            loading={retrying}
            accessibilityLabel={t('modelChat.mcp.retryServerA11y', { name: row.name })}
            onPress={onRetry}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          accessibilityLabel={t('modelChat.mcp.editServerA11y', { name: row.name })}
          onPress={onEdit}
        >
          <Text>{t('modelChat.mcp.editServer')}</Text>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          accessibilityLabel={t('modelChat.mcp.deleteServerA11y', { name: row.name })}
          onPress={onDelete}
        >
          <Text>{t('modelChat.mcp.deleteServer')}</Text>
        </Button>
      </View>
    </View>
  );
}
