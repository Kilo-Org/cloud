import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { skillRowSubtitle } from '@/components/profiles/skill-markdown';
import { SkillFormSheet, type SkillFormSubmission } from '@/components/profiles/skill-form-sheet';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Pencil, Sparkles, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfileMutations,
  useAgentProfileSkills,
} from '@/lib/hooks/use-agent-profiles';
import { useCanManageOrganizationProfiles } from '@/lib/hooks/use-can-manage-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useFormDraftState } from '@/lib/form-draft';
import { useProfileFormDraft } from '@/lib/hooks/use-profile-form-draft';
import { ICON_TARGET_BOX_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { MAX_PROFILE_SKILLS } from '@/lib/agent-profile-forms';
import { cn } from '@/lib/utils';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_SKILLS: AgentProfileDetail['skills'] = [];

/** The skill the sheet edits; `null` opens the sheet in add mode. */
type SkillTarget = { id: string; name: string; rawMarkdown: string };

/** A refused save, and whether it is a failure or an expected limit. */
type SaveFailure = { message: string; tone: 'error' | 'warn' };

type SkillRowProps = Readonly<{
  skill: AgentProfileDetail['skills'][number];
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
 * One skill row: the name in mono, its source type, the enabled switch,
 * and delete plus edit for local skills. The row carries no container
 * `accessibilityLabel`, so the switch's label stays the only element a screen
 * reader matches by the skill's name.
 */
function SkillRow({ skill, onToggle, onEdit, onDelete }: Readonly<SkillRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const subtitleKey = skillRowSubtitle(skill);
  const canEdit = skill.sourceType !== 'skills-sh';
  return (
    <View className="min-h-16 flex-row items-center gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="mono" numberOfLines={1}>
          {skill.name}
        </Text>
        <Text variant="muted" className="text-xs">
          {subtitleKey === null ? skill.sourceType : t(subtitleKey)}
        </Text>
      </View>
      <Switch
        value={skill.enabled}
        accessibilityLabel={skill.name}
        disabled={onToggle === undefined}
        onValueChange={onToggle}
      />
      {onEdit !== undefined && canEdit ? (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.skillEdit', { name: skill.name })}
          onPress={onEdit}
        >
          <Pencil size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
      {onDelete !== undefined ? (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.skillDelete', { name: skill.name })}
          onPress={onDelete}
        >
          <Trash2 size={18} color={colors.destructive} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Content-shaped rows in the same slot and height as a loaded skill row. */
function SkillsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-16 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}

export function ProfileSkillsScreen({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const profileQuery = useAgentProfileSkills(profileId, organizationId);
  const { createCustomSkill, updateSkill, deleteSkill, setSkillEnabled } =
    useAgentProfileMutations(organizationId);
  const canManage = useCanManageOrganizationProfiles(organizationId);

  const skills = profileQuery.data ?? NO_SKILLS;
  const atSkillCap = skills.length >= MAX_PROFILE_SKILLS;
  // `null` = closed, the add form, or the skill being edited. The sheet and the
  // fields it holds are a draft (`lib/form-draft`), so a remount reopens it on
  // what was typed instead of dropping it.
  const draftScope = `profiles:skills:${profileId}`;
  const form = useProfileFormDraft(draftScope, skills);
  const { startAdd: handleStartAdd, close: handleClose } = form;
  // The message the open sheet shows for a refused save, and whether it is a
  // failure or an expected limit. The mutation hook's toast sits behind the
  // sheet, so the reason is rendered inside it instead.
  const [saveFailure, setSaveFailure] = useFormDraftState<SaveFailure | null>(
    draftScope,
    'saveFailure',
    null
  );

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
      if (form.generation() !== generation) {
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
    if (form.generation() === generation) {
      form.close();
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
      title: t('common.delete'),
      message: skill.name,
      confirmLabel: t('common.delete'),
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
          canManage ? (
            <Button className={STATE_ACTION_CLASS} onPress={handleStartAdd}>
              <Text>{t('profiles.addSkill')}</Text>
            </Button>
          ) : null
        }
      />
    );
  } else {
    content = (
      <>
        {skills.map(skill => (
          <SkillRow
            key={skill.id}
            skill={skill}
            onToggle={
              canManage
                ? enabled => {
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
                  }
                : undefined
            }
            onEdit={
              canManage
                ? () => {
                    form.startEdit(skill);
                  }
                : undefined
            }
            onDelete={
              canManage
                ? () => {
                    confirmDelete({
                      id: skill.id,
                      name: skill.name,
                      rawMarkdown: skill.rawMarkdown,
                    });
                  }
                : undefined
            }
          />
        ))}
        {canManage ? (
          <>
            <Button onPress={handleStartAdd}>
              <Text>{t('profiles.addSkill')}</Text>
            </Button>
            {atSkillCap ? (
              <AccessibleStatus
                message={t('profiles.skillLimitReached', { max: MAX_PROFILE_SKILLS })}
                tone="warn"
                className="text-sm"
              />
            ) : null}
          </>
        ) : null}
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.skillsTitle')} />
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
        <SkillFormSheet
          draftScope={draftScope}
          skill={form.editing}
          isSaving={createCustomSkill.isPending || updateSkill.isPending}
          saveFailure={saveFailure?.message ?? null}
          saveFailureTone={saveFailure?.tone}
          onClose={handleClose}
          onSave={submission => {
            void saveSkill(form.editing, submission);
          }}
        />
      ) : null}

      {dialog}
    </View>
  );
}
