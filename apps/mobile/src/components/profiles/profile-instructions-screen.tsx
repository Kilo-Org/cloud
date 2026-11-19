/* eslint-disable max-lines -- profile-editor instructions: section body, sheet and delete flow share one screen */
import { type Href } from 'expo-router';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState, StateAction } from '@/components/empty-state';
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
import { FileText, Plus, Trash2 } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup } from '@/components/ui/row-group';
import { renderRowTrailing, RowIconAction } from '@/components/ui/row-trailing';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { MAX_PROFILE_INSTRUCTIONS } from '@/lib/agent-profile-forms';
import { isolateLtrBidiText } from '@/lib/bidi';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
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
 * the enabled switch and delete. The content is the edit action, so the row
 * carries two trailing controls instead of three; while the content opens the
 * form, both painted lines are hidden from assistive technology — the path
 * repeats the name — and the content press and the switch are what a reader
 * reaches. A row without an edit handler has no content to open: it renders
 * the frame's static row, where the path stays a text stop of its own instead
 * of being hidden for a control that does not exist.
 */
function InstructionRow({
  instruction,
  onToggle,
  onEdit,
  onDelete,
}: Readonly<InstructionRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const contentIsPress = onEdit !== undefined;
  // Only a row whose press names the path hides it; a static row keeps it.
  const pathLineA11y = contentIsPress ? HIDDEN_LABEL_PROPS : {};
  const trailing: ReactNode[] = [
    <Fragment key="enable">
      {renderRowTrailing({
        kind: 'switch',
        value: instruction.enabled,
        accessibilityLabel: instruction.name,
        disabled: onToggle === undefined,
        onValueChange: next => {
          onToggle?.(next);
        },
      })}
    </Fragment>,
  ];
  if (onDelete !== undefined) {
    trailing.push(
      <RowIconAction
        key="delete"
        label={t('profiles.instructionDelete', { name: instruction.name })}
        onPress={onDelete}
      >
        <Trash2 size={18} color={colors.mutedForeground} />
      </RowIconAction>
    );
  }
  return (
    <RowFrame
      leading={<IconTile icon={FileText} tint={NEUTRAL_TINT} />}
      pressTarget={contentIsPress ? 'content' : 'row'}
      onPress={onEdit}
      contentAccessibilityLabel={
        contentIsPress ? t('profiles.instructionEdit', { name: instruction.name }) : undefined
      }
      trailing={{ kind: 'nodes', nodes: trailing }}
    >
      <Text variant="mono" numberOfLines={1} {...HIDDEN_LABEL_PROPS}>
        {instruction.name}
      </Text>
      {/* Middle truncation keeps the file name, which is what tells two rules
          files apart; the folder is the part that repeats on every row. */}
      <Text
        variant="caption"
        className="mt-0.5"
        numberOfLines={1}
        ellipsizeMode="middle"
        {...pathLineA11y}
      >
        {`.kilocode/rules/${instruction.name}.md`}
      </Text>
    </RowFrame>
  );
}

/** Content-shaped rows in the same slot and height as a loaded instruction row. */
function InstructionsSkeleton() {
  return (
    <RowGroup>
      {[0, 1, 2].map(index => (
        <RowSkeleton key={index} tile subtitle trailingControl />
      ))}
    </RowGroup>
  );
}

export function ProfileInstructionsScreen({
  profileId,
  organizationId,
  backFallback,
}: Readonly<{ profileId: string; organizationId?: string; backFallback: Href }>) {
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
      // A file name is read position by position, so it keeps its own
      // left-to-right direction inside a right-to-left sentence.
      title: t('profiles.instructionDeleteTitle', { name: isolateLtrBidiText(instruction.name) }),
      message: t('profiles.instructionDeleteMessage'),
      confirmLabel: t('profiles.instructionDeleteConfirm'),
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
            <StateAction
              label={t('profiles.addInstruction')}
              icon={Plus}
              onPress={handleStartAdd}
            />
          </ProfileManageSlot>
        }
      />
    );
  } else {
    content = (
      <View className="gap-3">
        <RowGroup leadingTile>
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
        </RowGroup>
        <ProfileManageSlot permission={permission}>
          {atInstructionCap ? (
            <AccessibleStatus
              message={t('profiles.instructionLimitReached', { max: MAX_PROFILE_INSTRUCTIONS })}
              tone="warn"
              className="text-sm"
            />
          ) : null}
          <Button disabled={atInstructionCap} onPress={handleStartAdd}>
            <Text>{t('profiles.addInstruction')}</Text>
          </Button>
        </ProfileManageSlot>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ProfileSectionHeader
        profileId={profileId}
        organizationId={organizationId}
        title={t('profiles.instructionsTitle')}
        backFallback={backFallback}
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
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
          onSave={submission => saveInstruction(form.editing, submission)}
        />
      ) : null}

      {dialog}
    </View>
  );
}
