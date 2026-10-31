import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { McpServerRowView } from '@/components/profiles/mcp-server-row';
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
import { Server } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfileMcpServers,
  useAgentProfileSectionMutations,
} from '@/lib/hooks/use-agent-profiles';
import { useCanManageOrganizationProfiles } from '@/lib/hooks/use-can-manage-profiles';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useSheetRowTapGuard } from '@/lib/hooks/use-sheet-row-tap-guard';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_MCP_SERVERS: AgentProfileDetail['mcpServers'] = [];

/** The mutation hook toasts `error.message`; the screen supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
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
  // The list sits underneath the sheet, and a sheet dismisses natively, so the
  // second tap of a Save double tap would land on the row just saved.
  const { markClosed: markSheetClosed, guard: guardRowPress } = useSheetRowTapGuard();

  const startAdd = () => {
    setForm({ server: null });
    setServerNameConflict(false);
    setSaveFailure(null);
  };

  const closeForm = () => {
    markSheetClosed();
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
      if (!hasUsableMessage(error)) {
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
                  ? guardRowPress(enabled => {
                      setMcpEnabled.mutate(
                        { profileId, mcpServerId: server.id, enabled },
                        {
                          onError: error => {
                            if (!hasUsableMessage(error)) {
                              toast.error(t('profiles.mcp.updateFailed'));
                            }
                          },
                        }
                      );
                    })
                  : undefined
              }
              onEdit={
                canManage
                  ? guardRowPress(() => {
                      setForm({ server });
                      setServerNameConflict(false);
                      setSaveFailure(null);
                    })
                  : undefined
              }
              onDelete={
                canManage
                  ? guardRowPress(() => {
                      confirmDelete(server);
                    })
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
