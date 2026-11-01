import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { KiloCommandFormSheet } from '@/components/profiles/kilo-command-form-sheet';
import { KiloCommandRowView } from '@/components/profiles/kilo-command-row';
import {
  type KiloCommandCreatePayload,
  kiloCommandOrderAfterMove,
  kiloCommandRows,
  type KiloCommandSource,
  type KiloCommandUpdatePayload,
} from '@/components/profiles/profile-kilo-commands-model';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Terminal } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfileKiloCommands,
  useAgentProfileSectionMutations,
} from '@/lib/hooks/use-agent-profiles';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useSheetRowTapGuard } from '@/lib/hooks/use-sheet-row-tap-guard';
import { useCanManageOrganizationProfiles } from '@/lib/hooks/use-can-manage-profiles';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_COMMANDS: AgentProfileDetail['kiloCommands'] = [];

/** The mutation hook toasts `error.message`; the screen supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/** Content-shaped rows in the same slots as a loaded command row. */
function SlashCommandsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-24 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}

export function ProfileKiloCommandsScreen({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const profileQuery = useAgentProfileKiloCommands(profileId, organizationId);
  const {
    createKiloCommand,
    updateKiloCommand,
    deleteKiloCommand,
    setKiloCommandEnabled,
    reorderKiloCommands,
  } = useAgentProfileSectionMutations(organizationId);

  const canManage = useCanManageOrganizationProfiles(organizationId);

  const commands = profileQuery.data ?? NO_COMMANDS;
  const rows = kiloCommandRows(commands);
  // `null` = closed, `{ source: null }` = add, `{ source }` = edit that command.
  const [form, setForm] = useState<{ source: KiloCommandSource | null } | null>(null);
  // A save the server refused on the name index shows the inline conflict
  // instead of a toast the open sheet covers; any other refusal shows one line
  // inside the sheet. Both reset when the form opens and each save starts.
  const [serverNameConflict, setServerNameConflict] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  // The list sits underneath the sheet, and a sheet dismisses natively, so the
  // second tap of a Save double tap would land on the row just saved.
  const { markClosed: markSheetClosed, guard: guardRowPress } = useSheetRowTapGuard();

  const startAdd = () => {
    setForm({ source: null });
    setServerNameConflict(false);
    setSaveFailure(null);
  };

  const startEdit = (source: KiloCommandSource) => {
    setForm({ source });
    setServerNameConflict(false);
    setSaveFailure(null);
  };

  const closeForm = () => {
    markSheetClosed();
    setForm(null);
  };

  const reportRefusedSave = (error: unknown) => {
    if (readTrpcErrorField(error, 'code') === 'CONFLICT') {
      setServerNameConflict(true);
      return;
    }
    setSaveFailure(t('profiles.slashCommands.saveFailed'));
  };

  const runCreate = async (payload: KiloCommandCreatePayload) => {
    setServerNameConflict(false);
    setSaveFailure(null);
    try {
      await createKiloCommand.mutateAsync({ profileId, ...payload });
    } catch (error) {
      reportRefusedSave(error);
      return;
    }
    closeForm();
  };

  const runUpdate = async (commandId: string, payload: KiloCommandUpdatePayload) => {
    setServerNameConflict(false);
    setSaveFailure(null);
    try {
      await updateKiloCommand.mutateAsync({ profileId, commandId, ...payload });
    } catch (error) {
      reportRefusedSave(error);
      return;
    }
    closeForm();
  };

  const runDelete = async (commandId: string) => {
    try {
      await deleteKiloCommand.mutateAsync({ profileId, commandId });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.slashCommands.deleteFailed'));
      }
    }
  };

  const confirmDelete = (source: KiloCommandSource) => {
    confirm({
      title: t('common.delete'),
      message: source.name,
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        void runDelete(source.id);
      },
    });
  };

  const move = (index: number, delta: number) => {
    const orderedIds = kiloCommandOrderAfterMove(commands, index, delta);
    const unchanged = orderedIds.every((id, at) => commands[at]?.id === id);
    if (unchanged) {
      return;
    }
    reorderKiloCommands.mutate(
      { profileId, orderedIds },
      {
        onError: error => {
          if (!hasUsableMessage(error)) {
            toast.error(t('profiles.slashCommands.saveFailed'));
          }
        },
      }
    );
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
    content = <SlashCommandsSkeleton />;
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={Terminal}
        title={t('profiles.slashCommands.empty')}
        description={null}
        placement="top"
        action={
          canManage ? (
            <Button className={STATE_ACTION_CLASS} onPress={startAdd}>
              <Text>{t('profiles.slashCommands.add')}</Text>
            </Button>
          ) : null
        }
      />
    );
  } else {
    content = (
      <>
        {rows.map((row, index) => {
          const source = commands[index];
          if (source === undefined) {
            return null;
          }
          return (
            <KiloCommandRowView
              key={row.id}
              name={row.name}
              description={row.description}
              template={row.template}
              subtask={row.subtask}
              agent={row.agent}
              model={row.model}
              enabled={row.enabled}
              isFirst={index === 0}
              isLast={index === rows.length - 1}
              onToggle={
                canManage
                  ? guardRowPress(enabled => {
                      setKiloCommandEnabled.mutate(
                        { profileId, commandId: source.id, enabled },
                        {
                          onError: error => {
                            if (!hasUsableMessage(error)) {
                              toast.error(t('profiles.slashCommands.saveFailed'));
                            }
                          },
                        }
                      );
                    })
                  : undefined
              }
              onMoveUp={
                canManage
                  ? guardRowPress(() => {
                      move(index, -1);
                    })
                  : undefined
              }
              onMoveDown={
                canManage
                  ? guardRowPress(() => {
                      move(index, 1);
                    })
                  : undefined
              }
              onEdit={
                canManage
                  ? guardRowPress(() => {
                      startEdit(source);
                    })
                  : undefined
              }
              onDelete={
                canManage
                  ? guardRowPress(() => {
                      confirmDelete(source);
                    })
                  : undefined
              }
            />
          );
        })}
        {canManage ? (
          <Button onPress={startAdd}>
            <Text>{t('profiles.slashCommands.add')}</Text>
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.slashCommands.title')} />
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
        <KiloCommandFormSheet
          command={form.source}
          existingNames={commands
            .filter(candidate => candidate.id !== form.source?.id)
            .map(candidate => candidate.name)}
          isSaving={createKiloCommand.isPending || updateKiloCommand.isPending}
          nameConflictFromServer={serverNameConflict}
          saveFailure={saveFailure}
          onClose={closeForm}
          onCreate={payload => {
            void runCreate(payload);
          }}
          onUpdate={payload => {
            const source = form.source;
            if (source !== null) {
              void runUpdate(source.id, payload);
            }
          }}
        />
      ) : null}

      {dialog}
    </View>
  );
}
