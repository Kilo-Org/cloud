import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import {
  InstructionFormSheet,
  type InstructionFormSubmission,
} from '@/components/profiles/instruction-form-sheet';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
import { ProfileSectionHeader } from '@/components/profiles/profile-section-header';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FileText, Pencil, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { ICON_TARGET_BOX_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { MAX_PROFILE_INSTRUCTIONS } from '@/lib/agent-profile-forms';
import {
  type AgentProfileInstructionRow,
  useAgentProfileInstructions,
} from '@/lib/hooks/use-agent-profiles';
import { useAgentProfileInstructionMutations } from '@/lib/hooks/use-agent-profile-instruction-mutations';
import { useOrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { useProfileFormDraft } from '@/lib/hooks/use-profile-form-draft';
import { useSheetRowTapGuard } from '@/lib/hooks/use-sheet-row-tap-guard';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { cn } from '@/lib/utils';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_INSTRUCTIONS: AgentProfileInstructionRow[] = [];

/** The instruction the sheet edits; `null` opens the sheet in add mode. */
type InstructionTarget = { id: string; name: string };

/** A refused save, and whether it is a failure or an expected limit. */
type SaveFailure = { message: string; tone: 'error' | 'warn' };

type InstructionRowProps = Readonly<{
  instruction: AgentProfileInstructionRow;
  onToggle?: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}>;

/**
 * The mutation hook toasts `error.message`; the screen only supplies a
 * fallback when the server sent nothing readable.
 */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/**
 * One instruction row: the rules file name in mono, the path it is applied as,
 * the enabled switch, and delete plus edit. Both painted lines are hidden from
 * assistive technology — the path repeats the name — so the switch's label
 * stays the only element a screen reader matches by the file name.
 */
function InstructionRow({
  instruction,
  onToggle,
  onEdit,
  onDelete,
}: Readonly<InstructionRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="min-h-16 flex-row items-center gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="mono" numberOfLines={1} {...HIDDEN_LABEL_PROPS}>
          {instruction.name}
        </Text>
        <Text variant="muted" className="text-xs" numberOfLines={1} {...HIDDEN_LABEL_PROPS}>
          {`.kilocode/rules/${instruction.name}.md`}
        </Text>
      </View>
      <Switch
        value={instruction.enabled}
        accessibilityLabel={instruction.name}
        disabled={onToggle === undefined}
        onValueChange={onToggle}
      />
      {onEdit === undefined ? null : (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.instructionEdit', { name: instruction.name })}
          onPress={onEdit}
        >
          <Pencil size={18} color={colors.mutedForeground} />
        </Pressable>
      )}
      {onDelete === undefined ? null : (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.instructionDelete', { name: instruction.name })}
          onPress={onDelete}
        >
          <Trash2 size={18} color={colors.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}

/** Content-shaped rows in the same slot and height as a loaded instruction row. */
function InstructionsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-16 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}

export function ProfileInstructionsScreen({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const profileQuery = useAgentProfileInstructions(profileId, organizationId);
  const { createInstruction, updateInstruction, deleteInstruction, setInstructionEnabled } =
    useAgentProfileInstructionMutations(organizationId);
  const permission = useOrganizationProfilePermission(organizationId);
  const canManage = permission === 'allowed';

  const instructions = profileQuery.data ?? NO_INSTRUCTIONS;
  const atInstructionCap = instructions.length >= MAX_PROFILE_INSTRUCTIONS;
  const draftScope = `profiles:instructions:${profileId}`;
  // The open sheet's refusal is the form's note: the mutation hook's toast sits
  // behind the sheet, and opening or closing resets the note with the rest of
  // the draft.
  const form = useProfileFormDraft(draftScope, instructions, {
    saveFailure: null as SaveFailure | null,
  });
  // The list sits underneath the sheet, and a sheet dismisses natively, so the
  // second tap of a Save double tap would land on the row just saved.
  const { markClosed: markSheetClosed, guard: guardRowPress } = useSheetRowTapGuard();
  const { startAdd: handleStartAdd } = form;

  const handleClose = () => {
    markSheetClosed();
    form.close();
  };

  const setSaveFailure = (next: SaveFailure | null) => {
    form.setNotes({ saveFailure: next });
  };
  const saveFailure = form.notes.saveFailure;

  const instructionLimitFailure = (): SaveFailure => ({
    message: t('profiles.instructionLimitReached', { max: MAX_PROFILE_INSTRUCTIONS }),
    tone: 'warn',
  });

  const saveInstruction = async (
    target: InstructionTarget | null,
    submission: InstructionFormSubmission
  ) => {
    const generation = form.generation();
    setSaveFailure(null);
    // The server counts every instruction row of the profile, so a full list
    // cannot take another create: name the cap here instead of round-tripping.
    if (target === null && atInstructionCap) {
      setSaveFailure(instructionLimitFailure());
      return;
    }
    try {
      await (target === null
        ? createInstruction.mutateAsync({ profileId, ...submission })
        : updateInstruction.mutateAsync({ profileId, instructionId: target.id, ...submission }));
    } catch (error) {
      if (!form.isCurrent(generation)) {
        return;
      }
      // A create the server refused at the cap, e.g. the list was stale; an
      // update never hits the cap, so its PRECONDITION_FAILED (a name the
      // server reserves) keeps the generic message.
      const limited =
        target === null && readTrpcErrorField(error, 'code') === 'PRECONDITION_FAILED';
      setSaveFailure(
        limited
          ? instructionLimitFailure()
          : { message: t('profiles.instructionSaveFailed'), tone: 'error' }
      );
      return;
    }
    if (form.isCurrent(generation)) {
      handleClose();
    }
  };

  const runDelete = async (instructionId: string) => {
    try {
      await deleteInstruction.mutateAsync({ profileId, instructionId });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.instructionDeleteFailed'));
      }
    }
  };

  const confirmDelete = (instruction: InstructionTarget) => {
    confirm({
      title: t('common.delete'),
      message: instruction.name,
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        void runDelete(instruction.id);
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
    content = <InstructionsSkeleton />;
  } else if (instructions.length === 0) {
    content = (
      <EmptyState
        icon={FileText}
        title={t('profiles.instructionsEmpty')}
        description={t('profiles.instructionsEmptyDescription')}
        placement="top"
        action={
          <ProfileManageSlot permission={permission}>
            <Button className={STATE_ACTION_CLASS} onPress={handleStartAdd}>
              <Text>{t('profiles.addInstruction')}</Text>
            </Button>
          </ProfileManageSlot>
        }
      />
    );
  } else {
    content = (
      <>
        {instructions.map(instruction => (
          <InstructionRow
            key={instruction.id}
            instruction={instruction}
            onToggle={
              canManage
                ? guardRowPress(enabled => {
                    setInstructionEnabled.mutate(
                      { profileId, instructionId: instruction.id, enabled },
                      {
                        onError: error => {
                          if (!hasUsableMessage(error)) {
                            toast.error(t('profiles.instructionToggleFailed'));
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
                    form.startEdit(instruction);
                  })
                : undefined
            }
            onDelete={
              canManage
                ? guardRowPress(() => {
                    confirmDelete({ id: instruction.id, name: instruction.name });
                  })
                : undefined
            }
          />
        ))}
        <ProfileManageSlot permission={permission}>
          <Button onPress={handleStartAdd}>
            <Text>{t('profiles.addInstruction')}</Text>
          </Button>
          {atInstructionCap ? (
            <AccessibleStatus
              message={t('profiles.instructionLimitReached', { max: MAX_PROFILE_INSTRUCTIONS })}
              tone="warn"
              className="text-sm"
            />
          ) : null}
        </ProfileManageSlot>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ProfileSectionHeader
        profileId={profileId}
        organizationId={organizationId}
        title={t('profiles.instructionsTitle')}
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
        <InstructionFormSheet
          draftScope={draftScope}
          instruction={form.editing}
          isSaving={createInstruction.isPending || updateInstruction.isPending}
          saveFailure={saveFailure?.message ?? null}
          saveFailureTone={saveFailure?.tone}
          onClose={handleClose}
          onSave={submission => {
            void saveInstruction(form.editing, submission);
          }}
        />
      ) : null}

      {dialog}
    </View>
  );
}
