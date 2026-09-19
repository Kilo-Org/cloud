import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { skillRowSubtitle } from '@/components/profiles/skill-markdown';
import { SkillFormSheet, type SkillFormSubmission } from '@/components/profiles/skill-form-sheet';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Pencil, Sparkles, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfile,
  useAgentProfileMutations,
} from '@/lib/hooks/use-agent-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_SKILLS: AgentProfileDetail['skills'] = [];

/** The skill the sheet edits; `null` opens the sheet in add mode. */
type SkillTarget = { id: string; name: string; rawMarkdown: string };

type SkillRowProps = Readonly<{
  skill: AgentProfileDetail['skills'][number];
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}>;

/**
 * The mutation hook toasts `error.message`; the screen only supplies a
 * fallback when the server sent nothing readable.
 */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/**
 * One skill row: the name in mono, its source type, the enabled status, the
 * toggle, and edit/delete controls. The row carries no container
 * `accessibilityLabel`, so the switch's label stays the only element a screen
 * reader matches by the skill's name.
 */
function SkillRow({ skill, onToggle, onEdit, onDelete }: Readonly<SkillRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="min-h-16 flex-row items-center gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="mono" numberOfLines={1}>
          {skill.name}
        </Text>
        <Text variant="muted" className="text-xs">
          {skillRowSubtitle(skill)}
        </Text>
      </View>
      <Text className="text-xs text-muted-foreground">
        {skill.enabled ? t('common.enabled') : t('common.disabled')}
      </Text>
      <Switch value={skill.enabled} accessibilityLabel={skill.name} onValueChange={onToggle} />
      <Pressable
        className="h-11 w-11 items-center justify-center active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('profiles.skillEditTitle')}
        onPress={onEdit}
      >
        <Pencil size={18} color={colors.mutedForeground} />
      </Pressable>
      <Pressable
        className="h-11 w-11 items-center justify-center active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('common.delete')}
        onPress={onDelete}
      >
        <Trash2 size={18} color={colors.destructive} />
      </Pressable>
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
  const profileQuery = useAgentProfile(profileId, organizationId);
  const { createCustomSkill, updateSkill, deleteSkill, setSkillEnabled } =
    useAgentProfileMutations(organizationId);

  const skills = profileQuery.data?.skills ?? NO_SKILLS;
  // `null` = closed, `{ skill: null }` = add, `{ skill }` = edit that skill.
  const [form, setForm] = useState<{ skill: SkillTarget | null } | null>(null);

  const startAdd = () => {
    setForm({ skill: null });
  };

  const closeForm = () => {
    setForm(null);
  };

  const saveSkill = async (target: SkillTarget | null, submission: SkillFormSubmission) => {
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
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.skillSaveFailed'));
      }
      return;
    }
    closeForm();
  };

  const runDelete = async (skillId: string) => {
    try {
      await deleteSkill.mutateAsync({ profileId, skillId });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.skillSaveFailed'));
      }
    }
  };

  const confirmDelete = (skill: SkillTarget) => {
    Alert.alert(t('common.delete'), skill.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void runDelete(skill.id);
        },
      },
    ]);
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
          <Button onPress={startAdd}>
            <Text>{t('profiles.addSkill')}</Text>
          </Button>
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
            onToggle={enabled => {
              setSkillEnabled.mutate(
                { profileId, skillId: skill.id, enabled },
                {
                  onError: error => {
                    if (!hasUsableMessage(error)) {
                      toast.error(t('profiles.skillSaveFailed'));
                    }
                  },
                }
              );
            }}
            onEdit={() => {
              setForm({
                skill: { id: skill.id, name: skill.name, rawMarkdown: skill.rawMarkdown },
              });
            }}
            onDelete={() => {
              confirmDelete({
                id: skill.id,
                name: skill.name,
                rawMarkdown: skill.rawMarkdown,
              });
            }}
          />
        ))}
        <Button onPress={startAdd}>
          <Text>{t('profiles.addSkill')}</Text>
        </Button>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.skillsTitle')} />
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
        <SkillFormSheet
          skill={form.skill}
          isSaving={createCustomSkill.isPending || updateSkill.isPending}
          onClose={closeForm}
          onSave={submission => {
            void saveSkill(form.skill, submission);
          }}
        />
      ) : null}
    </View>
  );
}
