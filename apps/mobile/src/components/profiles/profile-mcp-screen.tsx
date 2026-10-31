import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
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
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Lock, Pencil, Server, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfileMcpServers,
  useAgentProfileSectionMutations,
} from '@/lib/hooks/use-agent-profiles';
import { useCanManageOrganizationProfiles } from '@/lib/hooks/use-can-manage-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { ICON_TARGET_BOX_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_MCP_SERVERS: AgentProfileDetail['mcpServers'] = [];

type McpServerRowProps = Readonly<{
  server: McpServerSource;
  summary: string;
  secretCount: number;
  onToggle?: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
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
          <Text variant="mono" numberOfLines={1} {...HIDDEN_LABEL_PROPS} className="shrink">
            {server.name}
          </Text>
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {server.type === 'local' ? t('profiles.mcp.localType') : t('profiles.mcp.remoteType')}
          </Text>
          {secretCount > 0 ? (
            <View
              accessible
              accessibilityRole="text"
              accessibilityLabel={t('profiles.mcp.secretCount', { count: secretCount })}
              className="flex-row items-center"
            >
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                className="flex-row items-center gap-0.5"
              >
                <Lock size={12} color={colors.mutedForeground} />
                <Text className="text-xs text-muted-foreground">{secretCount}</Text>
              </View>
            </View>
          ) : null}
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
          <Trash2 size={18} color={colors.destructive} />
        </Pressable>
      ) : null}
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
  const { confirm, dialog } = useConfirmDialog();
  const profileQuery = useAgentProfileMcpServers(profileId, organizationId);
  const { createMcp, updateMcp, deleteMcp, setMcpEnabled } =
    useAgentProfileSectionMutations(organizationId);
  const canManage = useCanManageOrganizationProfiles(organizationId);

  const servers = profileQuery.data ?? NO_MCP_SERVERS;
  const rows = mcpServerRows(servers);
  // `null` = closed, `{ server: null }` = add, `{ server }` = edit that server.
  const [form, setForm] = useState<{ server: McpServerSource | null } | null>(null);
  // A save the server refused on the name index shows the inline conflict
  // instead of a toast the open sheet covers; any other refusal shows one line
  // inside the sheet. Both reset when the form opens and each save starts.
  const [serverNameConflict, setServerNameConflict] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  const startAdd = () => {
    setForm({ server: null });
    setServerNameConflict(false);
    setSaveFailure(null);
  };

  const closeForm = () => {
    setForm(null);
  };

  const saveServer = async (target: McpServerSource | null, payload: McpServerPayload) => {
    setServerNameConflict(false);
    setSaveFailure(null);
    try {
      await (target === null
        ? createMcp.mutateAsync({ profileId, server: payload })
        : updateMcp.mutateAsync({ profileId, mcpServerId: target.id, server: payload }));
    } catch (error) {
      if (readTrpcErrorField(error, 'code') === 'CONFLICT') {
        setServerNameConflict(true);
        return;
      }
      setSaveFailure(t('profiles.mcp.saveFailed'));
      return;
    }
    closeForm();
  };

  const runDelete = async (mcpServerId: string) => {
    try {
      await deleteMcp.mutateAsync({ profileId, mcpServerId });
    } catch (error) {
      // The cleanup hook toasts a readable message itself; a silent failure gets ours.
      if (!(error instanceof Error) || error.message.trim().length === 0) {
        toast.error(t('profiles.mcp.deleteFailed'));
      }
    }
  };

  const confirmDelete = (target: McpServerSource) => {
    confirm({
      title: t('common.delete'),
      message: target.name,
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        void runDelete(target.id);
      },
    });
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
          canManage ? (
            <Button className={STATE_ACTION_CLASS} onPress={startAdd}>
              <Text>{t('profiles.mcp.add')}</Text>
            </Button>
          ) : null
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
              onToggle={
                canManage
                  ? enabled => {
                      setMcpEnabled.mutate(
                        { profileId, mcpServerId: server.id, enabled },
                        {
                          onError: error => {
                            if (!(error instanceof Error) || error.message.trim().length === 0) {
                              toast.error(t('profiles.mcp.updateFailed'));
                            }
                          },
                        }
                      );
                    }
                  : undefined
              }
              onEdit={
                canManage
                  ? () => {
                      setForm({ server });
                      setServerNameConflict(false);
                      setSaveFailure(null);
                    }
                  : undefined
              }
              onDelete={
                canManage
                  ? () => {
                      confirmDelete(server);
                    }
                  : undefined
              }
            />
          );
        })}
        {canManage ? (
          <Button onPress={startAdd}>
            <Text>{t('profiles.mcp.add')}</Text>
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.mcp.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {content}
      </TabScreenScrollView>

      {form !== null ? (
        <McpFormSheet
          server={form.server}
          existingNames={servers
            .filter(candidate => candidate.id !== form.server?.id)
            .map(candidate => candidate.name)}
          isSaving={createMcp.isPending || updateMcp.isPending}
          nameConflictFromServer={serverNameConflict}
          saveFailure={saveFailure}
          onClose={closeForm}
          onSave={payload => {
            void saveServer(form.server, payload);
          }}
        />
      ) : null}

      {dialog}
    </View>
  );
}
