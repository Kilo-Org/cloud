import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import {
  KiloCommandFormSheet,
  type KiloCommandSubmission,
} from '@/components/profiles/kilo-command-form-sheet';
import { KiloCommandRowView } from '@/components/profiles/kilo-command-row';
import {
  kiloCommandOrderAfterMove,
  kiloCommandRows,
  type KiloCommandSource,
  type KiloCommandUpdatePayload,
} from '@/components/profiles/profile-kilo-commands-model';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Terminal } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfile,
  useAgentProfileSectionMutations,
} from '@/lib/hooks/use-agent-profiles';

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
  const profileQuery = useAgentProfile(profileId, organizationId);
  const {
    createKiloCommand,
    updateKiloCommand,
    deleteKiloCommand,
    setKiloCommandEnabled,
    reorderKiloCommands,
  } = useAgentProfileSectionMutations(organizationId);

  const commands = profileQuery.data?.kiloCommands ?? NO_COMMANDS;
  const rows = kiloCommandRows(commands);
  // `null` = closed, `{ source: null }` = add, `{ source }` = edit that command.
  const [form, setForm] = useState<{ source: KiloCommandSource | null } | null>(null);

  const startAdd = () => {
    setForm({ source: null });
  };

  const closeForm = () => {
    setForm(null);
  };

  const runCreate = async (payload: KiloCommandSubmission) => {
    try {
      await createKiloCommand.mutateAsync({ profileId, ...payload });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.slashCommands.saveFailed'));
      }
      return;
    }
    closeForm();
  };

  const runUpdate = async (commandId: string, payload: KiloCommandUpdatePayload) => {
    try {
      await updateKiloCommand.mutateAsync({ profileId, commandId, ...payload });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.slashCommands.saveFailed'));
      }
      return;
    }
    closeForm();
  };

  const runDelete = async (commandId: string) => {
    try {
      await deleteKiloCommand.mutateAsync({ profileId, commandId });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.slashCommands.saveFailed'));
      }
    }
  };

  const confirmDelete = (source: KiloCommandSource) => {
    Alert.alert(t('common.delete'), source.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void runDelete(source.id);
        },
      },
    ]);
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
          <Button onPress={startAdd}>
            <Text>{t('profiles.slashCommands.add')}</Text>
          </Button>
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
              onToggle={enabled => {
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
              }}
              onMoveUp={() => {
                move(index, -1);
              }}
              onMoveDown={() => {
                move(index, 1);
              }}
              onEdit={() => {
                setForm({ source });
              }}
              onDelete={() => {
                confirmDelete(source);
              }}
            />
          );
        })}
        <Button onPress={startAdd}>
          <Text>{t('profiles.slashCommands.add')}</Text>
        </Button>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.slashCommands.title')} />
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
        <KiloCommandFormSheet
          command={form.source}
          isSaving={createKiloCommand.isPending || updateKiloCommand.isPending}
          onClose={closeForm}
          onCreate={payload => {
            void runCreate(payload);
          }}
          onUpdate={payload => {
            if (form.source !== null) {
              void runUpdate(form.source.id, payload);
            }
          }}
        />
      ) : null}
    </View>
  );
}
