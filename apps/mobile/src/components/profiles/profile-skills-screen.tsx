/* eslint-disable max-lines -- profile-editor skills: section body, sheet and delete flow share one screen */
import { type Href } from 'expo-router';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState, StateAction } from '@/components/empty-state';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
import { ProfileSectionHeader } from '@/components/profiles/profile-section-header';
import { skillRowSubtitle } from '@/components/profiles/skill-markdown';
import { SkillFormSheet, type SkillFormSubmission } from '@/components/profiles/skill-form-sheet';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Plus, Sparkles, Trash2 } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { renderRowTrailing, RowIconAction } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfileMutations,
  useAgentProfileSkills,
} from '@/lib/hooks/use-agent-profiles';
import { useOrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { useProfileFormDraft } from '@/lib/hooks/use-profile-form-draft';
import { MAX_PROFILE_SKILLS } from '@/lib/agent-profile-forms';
import { isolateLtrBidiText } from '@/lib/bidi';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSheetRowTapGuard } from '@/lib/hooks/use-sheet-row-tap-guard';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_SKILLS: AgentProfileDetail['skills'] = [];

/** The skill the sheet edits; `null` opens the sheet in add mode. */
type SkillTarget = { id: string; name: string; rawMarkdown: string };

/** A refused save, and whether it is a failure or an expected limit. */
type SaveFailure = { message: string; tone: 'error' | 'warn' };

type SkillRowProps = Readonly<{
  skill: AgentProfileDetail['skills'][number];
  /**
   * The list holds more than one source kind, so the source tells rows apart.
   * When every row has the same source it repeats what the whole list already
   * says, and the row leaves it out.
   */
  showSource: boolean;
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
 * One skill row: the name in mono, its source when the list mixes sources, the
 * enabled switch and delete. The content is the edit action — the form sheet has
 * no delete of its own — so the row carries two trailing controls instead of
 * three; a skills.sh reference has no edit surface here, so its content is inert.
 * While the content opens the form, its press and the switch are what a reader
 * reaches. A row with no content to open (a read-only profile, or a skills.sh
 * reference) renders the frame's static row instead, where the source stays a
 * text stop of its own rather than being hidden for a control that does not
 * exist.
 */
function SkillRow({ skill, showSource, onToggle, onEdit, onDelete }: Readonly<SkillRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const subtitleKey = skillRowSubtitle(skill);
  const subtitle = subtitleKey === null ? skill.sourceType : t(subtitleKey);
  const canEdit = skill.sourceType !== 'skills-sh';
  const edit = canEdit ? onEdit : undefined;
  const contentIsPress = edit !== undefined;
  // Only a row whose press names the source hides it; a static row keeps it.
  const factLineA11y = contentIsPress ? HIDDEN_LABEL_PROPS : {};
  const trailing: ReactNode[] = [
    <Fragment key="enable">
      {renderRowTrailing({
        kind: 'switch',
        value: skill.enabled,
        accessibilityLabel: skill.name,
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
        label={t('profiles.skillDelete', { name: skill.name })}
        onPress={onDelete}
      >
        <Trash2 size={18} color={colors.mutedForeground} />
      </RowIconAction>
    );
  }
  return (
    <RowFrame
      leading={<IconTile icon={Sparkles} tint={NEUTRAL_TINT} />}
      pressTarget={contentIsPress ? 'content' : 'row'}
      onPress={edit}
      contentAccessibilityLabel={
        contentIsPress ? t('profiles.skillEdit', { name: skill.name }) : undefined
      }
      trailing={{ kind: 'nodes', nodes: trailing }}
    >
      <Text variant="mono" numberOfLines={1} {...HIDDEN_LABEL_PROPS}>
        {skill.name}
      </Text>
      {showSource ? (
        <Text variant="caption" className="mt-0.5" {...factLineA11y}>
          {subtitle}
        </Text>
      ) : null}
    </RowFrame>
  );
}

/** Content-shaped rows in the same slot and height as a loaded skill row. */
function SkillsSkeleton() {
  return (
    <RowGroup>
      {[0, 1, 2].map(index => (
        <RowSkeleton key={index} tile subtitle trailingControl />
      ))}
    </RowGroup>
  );
}

export function ProfileSkillsScreen({
  profileId,
  organizationId,
  backFallback,
}: Readonly<{ profileId: string; organizationId?: string; backFallback: Href }>) {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const profileQuery = useAgentProfileSkills(profileId, organizationId);
  const { createCustomSkill, updateSkill, deleteSkill, setSkillEnabled } =
    useAgentProfileMutations(organizationId);
  const permission = useOrganizationProfilePermission(organizationId);
  const canManage = permission === 'allowed';

  const skills = profileQuery.data ?? NO_SKILLS;
  const atSkillCap = skills.length >= MAX_PROFILE_SKILLS;
  // The source only tells rows apart in a list that holds more than one kind; a
  // list of one kind says it once for the whole group instead of on every row.
  const mixedSources = skills.some(skill => skill.sourceType !== skills[0]?.sourceType);
  // `null` = closed, the add form, or the skill being edited. The sheet and the
  // fields it holds are a draft (`lib/form-draft`), so a remount reopens it on
  // what was typed instead of dropping it.
  const draftScope = `profiles:skills:${profileId}`;
  // The message the open sheet shows for a refused save, and whether it is a
  // failure or an expected limit, is the form's note: the mutation hook's toast
  // sits behind the sheet, and opening or closing resets the note with the rest
  // of the draft.
  const form = useProfileFormDraft(draftScope, skills, { saveFailure: null as SaveFailure | null });
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

  const skillLimitFailure = (): SaveFailure => ({
    message: t('profiles.skillLimitReached', { max: MAX_PROFILE_SKILLS }),
    tone: 'warn',
  });

  const saveSkill = async (target: SkillTarget | null, submission: SkillFormSubmission) => {
    const generation = form.generation();
    setSaveFailure(null);
    // The server counts every skill row of the profile, so a full list cannot
    // take another create: name the cap here instead of round-tripping for it.
    if (target === null && atSkillCap) {
      setSaveFailure(skillLimitFailure());
      return;
    }
    try {
      await (target === null
        ? createCustomSkill.mutateAsync({ profileId, ...submission })
        : updateSkill.mutateAsync({
            profileId,
            skillId: target.id,
            ...submission,
            description: submission.description ?? null,
          }));
    } catch (error) {
      if (!form.isCurrent(generation)) {
        return;
      }
      // A create the server refused at the cap, e.g. the list was stale; an
      // update never hits the cap, so its PRECONDITION_FAILED (an unmodifiable
      // skills.sh reference) keeps the generic message.
      const limited =
        target === null && readTrpcErrorField(error, 'code') === 'PRECONDITION_FAILED';
      setSaveFailure(
        limited ? skillLimitFailure() : { message: t('profiles.skillSaveFailed'), tone: 'error' }
      );
      return;
    }
    if (form.isCurrent(generation)) {
      handleClose();
    }
  };

  const runDelete = async (skillId: string) => {
    try {
      await deleteSkill.mutateAsync({ profileId, skillId });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.skillDeleteFailed'));
      }
    }
  };

  const confirmDelete = (skill: SkillTarget) => {
    confirm({
      // An identifier reads position by position, so it keeps its left-to-right direction.
      title: t('profiles.skillDeleteTitle', { name: isolateLtrBidiText(skill.name) }),
      message: t('profiles.skillDeleteMessage'),
      confirmLabel: t('profiles.skillDeleteConfirm'),
      onConfirm: () => {
        void runDelete(skill.id);
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
    content = <SkillsSkeleton />;
  } else if (skills.length === 0) {
    content = (
      <EmptyState
        icon={Sparkles}
        title={t('profiles.skillsEmpty')}
        description={null}
        placement="top"
        action={
          <ProfileManageSlot permission={permission}>
            <StateAction label={t('profiles.addSkill')} icon={Plus} onPress={handleStartAdd} />
          </ProfileManageSlot>
        }
      />
    );
  } else {
    content = (
      <View className="gap-3">
        <RowGroup leadingTile>
          {skills.map(skill => (
            <SkillRow
              key={skill.id}
              skill={skill}
              showSource={mixedSources}
              onToggle={
                canManage
                  ? guardRowPress(enabled => {
                      setSkillEnabled.mutate(
                        { profileId, skillId: skill.id, enabled },
                        {
                          onError: error => {
                            if (!hasUsableMessage(error)) {
                              toast.error(t('profiles.skillToggleFailed'));
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
                      form.startEdit(skill);
                    })
                  : undefined
              }
              onDelete={
                canManage
                  ? guardRowPress(() => {
                      confirmDelete({
                        id: skill.id,
                        name: skill.name,
                        rawMarkdown: skill.rawMarkdown,
                      });
                    })
                  : undefined
              }
            />
          ))}
        </RowGroup>
        <ProfileManageSlot permission={permission}>
          {atSkillCap ? (
            <AccessibleStatus
              message={t('profiles.skillLimitReached', { max: MAX_PROFILE_SKILLS })}
              tone="warn"
              className="text-sm"
            />
          ) : null}
          <Button disabled={atSkillCap} onPress={handleStartAdd}>
            <Text>{t('profiles.addSkill')}</Text>
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
        title={t('profiles.skillsTitle')}
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
        <SkillFormSheet
          draftScope={draftScope}
          skill={form.editing}
          isSaving={createCustomSkill.isPending || updateSkill.isPending}
          saveFailure={saveFailure?.message ?? null}
          saveFailureTone={saveFailure?.tone}
          onClose={handleClose}
          onSave={submission => saveSkill(form.editing, submission)}
        />
      ) : null}

      {dialog}
    </View>
  );
}
