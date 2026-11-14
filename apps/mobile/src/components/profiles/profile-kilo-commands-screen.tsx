import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import {
  KiloCommandFormSheet,
  type KiloCommandSaveFailure,
} from '@/components/profiles/kilo-command-form-sheet';
import { KiloCommandRowView } from '@/components/profiles/kilo-command-row';
import {
  type KiloCommandCreatePayload,
  kiloCommandOrderAfterMove,
  kiloCommandRows,
  type KiloCommandSource,
  type KiloCommandUpdatePayload,
} from '@/components/profiles/profile-kilo-commands-model';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
import { ProfileSectionHeader } from '@/components/profiles/profile-section-header';
import { QueryError } from '@/components/query-error';
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
import { isolateLtrBidiText } from '@/lib/bidi';
import { useSheetRowTapGuard } from '@/lib/hooks/use-sheet-row-tap-guard';
import { useOrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { useProfileFormDraft } from '@/lib/hooks/use-profile-form-draft';
import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_COMMANDS: AgentProfileDetail['kiloCommands'] = [];

/** One save this screen can start: a create, or an update of the command it edits. */
type CommandSaveIntent =
  | { readonly kind: 'create'; readonly payload: KiloCommandCreatePayload }
  | {
      readonly kind: 'update';
      readonly target: KiloCommandSource;
      readonly payload: KiloCommandUpdatePayload;
    };

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

  const permission = useOrganizationProfilePermission(organizationId);
  const canManage = permission === 'allowed';

  const commands = profileQuery.data ?? NO_COMMANDS;
  const rows = kiloCommandRows(commands);
  // The open form comes from the sibling screens' draft contract: it survives a
  // remount, and its generation is what proves a settling save still owns it.
  const draftScope = `profiles:slash-commands:${profileId}`;
  const form = useProfileFormDraft<KiloCommandSource, null>(draftScope, commands, null);
  // Admission is keyed by the resource being saved, so reopening a command whose
  // save is still running cannot admit a second save for it.
  const saves = useKeyedSurfaceFeedback<string, KiloCommandSaveFailure>();
  const formKey = form.editing?.id ?? 'new';
  const phase = saves.snapshot.states.get(formKey);
  const saveFailure = phase?.status === 'failed' ? phase.failure : null;
  // The list sits underneath the sheet, and a sheet dismisses natively, so the
  // second tap of a Save double tap would land on the row just saved.
  const { markClosed: markSheetClosed, guard: guardRowPress } = useSheetRowTapGuard();

  const startAdd = () => {
    form.startAdd();
    // A settled refusal belongs to the previous form: retire it, without
    // touching a save that is still pending for the same command.
    saves.clearWhere('new', () => true);
  };

  const startEdit = (source: KiloCommandSource) => {
    form.startEdit(source);
    saves.clearWhere(source.id, () => true);
  };

  const handleClose = () => {
    markSheetClosed();
    form.close();
  };

  /** One save this screen can start: a create, or an update of the command it edits. */
  const saveCommand = async (intent: CommandSaveIntent) => {
    const key = intent.kind === 'create' ? 'new' : intent.target.id;
    const generation = form.generation();
    const attempt = saves.begin(key);
    if (attempt === null) {
      // Already saving this command.
      return;
    }
    try {
      if (intent.kind === 'create') {
        await createKiloCommand.mutateAsync({ profileId, ...intent.payload });
      } else {
        await updateKiloCommand.mutateAsync({
          profileId,
          commandId: intent.target.id,
          ...intent.payload,
        });
      }
    } catch (error) {
      const failure: KiloCommandSaveFailure =
        readTrpcErrorField(error, 'code') === 'CONFLICT'
          ? { kind: 'name-conflict' }
          : { kind: 'refused' };
      // The failure belongs to the resource, so it is safe to publish even after
      // the form closed; `isCurrent` fences the side effect, not the record.
      attempt.fail(failure);
      return;
    }
    if (attempt.abandon() && form.isCurrent(generation)) {
      handleClose();
    }
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
      // An identifier reads position by position, so it keeps its left-to-right direction.
      title: t('profiles.slashCommands.deleteTitle', { name: isolateLtrBidiText(source.name) }),
      message: t('profiles.slashCommands.deleteMessage'),
      confirmLabel: t('profiles.slashCommands.deleteConfirm'),
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
          <ProfileManageSlot permission={permission}>
            <Button className={STATE_ACTION_CLASS} onPress={startAdd}>
              <Text>{t('profiles.slashCommands.add')}</Text>
            </Button>
          </ProfileManageSlot>
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
        <ProfileManageSlot permission={permission}>
          <Button onPress={startAdd}>
            <Text>{t('profiles.slashCommands.add')}</Text>
          </Button>
        </ProfileManageSlot>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ProfileSectionHeader
        profileId={profileId}
        organizationId={organizationId}
        title={t('profiles.slashCommands.title')}
      />
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
        <KiloCommandFormSheet
          command={form.editing}
          existingNames={commands
            .filter(candidate => candidate.id !== form.editing?.id)
            .map(candidate => candidate.name)}
          isSaving={phase?.status === 'pending'}
          saveFailure={saveFailure}
          onFieldEdited={() => {
            saves.clearWhere(formKey, () => true);
          }}
          onClose={handleClose}
          onCreate={payload => {
            void saveCommand({ kind: 'create', payload });
          }}
          onUpdate={payload => {
            const target = form.editing;
            if (target !== null) {
              void saveCommand({ kind: 'update', target, payload });
            }
          }}
        />
      ) : null}

      {dialog}
    </View>
  );
}
