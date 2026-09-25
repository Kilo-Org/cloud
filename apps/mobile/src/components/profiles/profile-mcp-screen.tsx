import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { McpFormSheet } from '@/components/profiles/mcp-form-sheet';
import {
  type McpServerPayload,
  mcpServerRows,
  type McpServerSource,
} from '@/components/profiles/profile-mcp-model';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Lock, Pencil, Server, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfile,
  useAgentProfileSectionMutations,
} from '@/lib/hooks/use-agent-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_MCP_SERVERS: AgentProfileDetail['mcpServers'] = [];

/** The mutation hook toasts `error.message`; the screen supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

type McpServerRowProps = Readonly<{
  server: McpServerSource;
  summary: string;
  secretCount: number;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}>;

/**
 * One MCP server row: the name in mono, its type, the command/URL summary, the
 * enabled switch and a lock badge with the masked env/header key count. The row
 * carries no container `accessibilityLabel`, so the switch's label stays the
 * only element a screen reader matches by the server's name.
 */
function McpServerRowView({
  server,
  summary,
  secretCount,
  onToggle,
  onEdit,
  onDelete,
}: McpServerRowProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="min-h-16 flex-row items-center gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text variant="mono" numberOfLines={1} className="shrink">
            {server.name}
          </Text>
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {server.type === 'local' ? t('profiles.mcp.localType') : t('profiles.mcp.remoteType')}
          </Text>
          {secretCount > 0 ? (
            <View
              className="flex-row items-center gap-0.5"
              accessibilityLabel={t('profiles.mcp.secretCount')}
            >
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
      </View>
      <Text className="text-xs text-muted-foreground">
        {server.enabled ? t('common.enabled') : t('common.disabled')}
      </Text>
      <Switch value={server.enabled} accessibilityLabel={server.name} onValueChange={onToggle} />
      <Pressable
        className="h-11 w-11 items-center justify-center active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('profiles.mcp.edit')}
        onPress={onEdit}
      >
        <Pencil size={18} color={colors.mutedForeground} />
      </Pressable>
      <Pressable
        className="h-11 w-11 items-center justify-center active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('common.delete')}
        onPress={onDelete}
      >
        <Trash2 size={18} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

/** Content-shaped rows in the same slot and height as a loaded server row. */
function McpSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-16 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}

export function ProfileMcpScreen({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const profileQuery = useAgentProfile(profileId, organizationId);
  const { createMcp, updateMcp, deleteMcp, setMcpEnabled } =
    useAgentProfileSectionMutations(organizationId);

  const servers = profileQuery.data?.mcpServers ?? NO_MCP_SERVERS;
  const rows = mcpServerRows(servers);
  // `null` = closed, `{ server: null }` = add, `{ server }` = edit that server.
  const [form, setForm] = useState<{ server: McpServerSource | null } | null>(null);

  const startAdd = () => {
    setForm({ server: null });
  };

  const closeForm = () => {
    setForm(null);
  };

  const saveServer = async (target: McpServerSource | null, payload: McpServerPayload) => {
    try {
      await (target === null
        ? createMcp.mutateAsync({ profileId, server: payload })
        : updateMcp.mutateAsync({ profileId, mcpServerId: target.id, server: payload }));
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.mcp.saveFailed'));
      }
      return;
    }
    closeForm();
  };

  const runDelete = async (mcpServerId: string) => {
    try {
      await deleteMcp.mutateAsync({ profileId, mcpServerId });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.mcp.saveFailed'));
      }
    }
  };

  const confirmDelete = (target: McpServerSource) => {
    Alert.alert(t('common.delete'), target.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void runDelete(target.id);
        },
      },
    ]);
  };

  let content: ReactNode = null;
  if (profileQuery.isError) {
    content = (
      <QueryError
        variant="server"
        placement="top"
        title={t('profiles.loadFailed')}
        onRetry={() => void profileQuery.refetch()}
        isRetrying={profileQuery.isRefetching}
      />
    );
  } else if (profileQuery.isPending) {
    content = <McpSkeleton />;
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={Server}
        title={t('profiles.mcp.empty')}
        description={null}
        placement="top"
        action={
          <Button onPress={startAdd}>
            <Text>{t('profiles.mcp.add')}</Text>
          </Button>
        }
      />
    );
  } else {
    content = (
      <>
        {rows.map((row, index) => {
          const server = servers[index];
          if (server === undefined) {
            return null;
          }
          return (
            <McpServerRowView
              key={row.id}
              server={server}
              summary={row.summary}
              secretCount={row.secretCount}
              onToggle={enabled => {
                setMcpEnabled.mutate(
                  { profileId, mcpServerId: server.id, enabled },
                  {
                    onError: error => {
                      if (!hasUsableMessage(error)) {
                        toast.error(t('profiles.mcp.saveFailed'));
                      }
                    },
                  }
                );
              }}
              onEdit={() => {
                setForm({ server });
              }}
              onDelete={() => {
                confirmDelete(server);
              }}
            />
          );
        })}
        <Button onPress={startAdd}>
          <Text>{t('profiles.mcp.add')}</Text>
        </Button>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.mcp.title')} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {content}
      </ScrollView>

      {form !== null ? (
        <McpFormSheet
          server={form.server}
          isSaving={createMcp.isPending || updateMcp.isPending}
          onClose={closeForm}
          onSave={payload => {
            void saveServer(form.server, payload);
          }}
        />
      ) : null}
    </View>
  );
}
