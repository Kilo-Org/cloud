import { type ReactNode } from 'react';
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
import { useProfileFormDraft } from '@/lib/hooks/use-profile-form-draft';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useSheetRowTapGuard } from '@/lib/hooks/use-sheet-row-tap-guard';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_MCP_SERVERS: AgentProfileDetail['mcpServers'] = [];

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
  // The open form, its fields and the refusal the sheet shows are one draft, so
  // opening or closing the form resets the refusal with everything else.
  const draftScope = `profiles:mcp:${profileId}`;
  const form = useProfileFormDraft(draftScope, servers, {
    conflict: false,
    failure: null as string | null,
  });
  // The list sits underneath the sheet, and a sheet dismisses natively, so the
  // second tap of a Save double tap would land on the row just saved.
  const { markClosed: markSheetClosed, guard: guardRowPress } = useSheetRowTapGuard();
  const { startAdd: handleStartAdd } = form;

  const handleClose = () => {
    markSheetClosed();
    form.close();
  };

  const saveServer = async (target: McpServerSource | null, payload: McpServerPayload) => {
    // The form this save belongs to. A remount keeps it alive; a later open or
    // close replaces it, and this attempt must then leave the new form alone.
    const generation = form.generation();
    form.setNotes({ conflict: false, failure: null });
    try {
      await (target === null
        ? createMcp.mutateAsync({ profileId, server: payload })
        : updateMcp.mutateAsync({ profileId, mcpServerId: target.id, server: payload }));
    } catch (error) {
      if (!form.isCurrent(generation)) {
        return;
      }
      if (readTrpcErrorField(error, 'code') === 'CONFLICT') {
        form.setNotes({ conflict: true, failure: null });
        return;
      }
      form.setNotes({ conflict: false, failure: t('profiles.mcp.saveFailed') });
      return;
    }
    if (form.isCurrent(generation)) {
      handleClose();
    }
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
            <Button className={STATE_ACTION_CLASS} onPress={handleStartAdd}>
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
                            if (!(error instanceof Error) || error.message.trim().length === 0) {
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
                      form.startEdit(server);
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
          <Button onPress={handleStartAdd}>
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

      {form.isOpen ? (
        <McpFormSheet
          draftScope={draftScope}
          server={form.editing}
          existingNames={servers
            .filter(candidate => candidate.id !== form.editing?.id)
            .map(candidate => candidate.name)}
          isSaving={createMcp.isPending || updateMcp.isPending}
          nameConflictFromServer={form.notes.conflict}
          saveFailure={form.notes.failure}
          onClose={handleClose}
          onSave={payload => {
            void saveServer(form.editing, payload);
          }}
        />
      ) : null}

      {dialog}
    </View>
  );
}
