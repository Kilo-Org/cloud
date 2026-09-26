import { type Href, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import {
  defaultControlLabel,
  defaultDescriptionKey,
  deleteErrorMessage,
  metadataFormKey,
  type OverviewSectionKey,
  overviewSectionRows,
} from '@/components/profiles/profile-overview-model';
import { ProfileOverviewSkeleton } from '@/components/profiles/profile-overview-skeleton';
import { ProfileRepoPinsSection } from '@/components/profiles/profile-repo-pins-section';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { FormField } from '@/components/ui/form-field';
import {
  Bot,
  CornerDownLeft,
  KeyRound,
  type LucideIcon,
  Server,
  Sparkles,
  Star,
  Terminal,
  Trash2,
} from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { Text } from '@/components/ui/text';
import { validateProfileDescription, validateProfileName } from '@/lib/agent-profile-forms';
import {
  type AgentProfileDetail,
  useAgentProfile,
  useAgentProfileMutations,
} from '@/lib/hooks/use-agent-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getProfileAgentsPath,
  getProfileCommandsPath,
  getProfileMcpPath,
  getProfileSkillsPath,
  getProfileSlashCommandsPath,
  getProfileVariablesPath,
} from '@/lib/profile-agent-navigation';

/** Icon per Overview section, matching the section's purpose. */
const SECTION_ICONS = {
  variables: KeyRound,
  commands: Terminal,
  slashCommands: CornerDownLeft,
  mcp: Server,
  skills: Sparkles,
  agents: Bot,
} satisfies Record<OverviewSectionKey, LucideIcon>;

/** Route builder per Overview section, carrying the profile's context. */
const SECTION_PATHS = {
  variables: getProfileVariablesPath,
  commands: getProfileCommandsPath,
  slashCommands: getProfileSlashCommandsPath,
  mcp: getProfileMcpPath,
  skills: getProfileSkillsPath,
  agents: getProfileAgentsPath,
} satisfies Record<OverviewSectionKey, (profileId: string, organizationId?: string) => Href>;

/**
 * The mutation hook toasts `error.message`; the screen only supplies a
 * fallback when the server sent nothing readable.
 */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

type MetadataFormProps = Readonly<{
  profile: AgentProfileDetail;
  isSaving: boolean;
  onSave: (values: { name: string; description: string }) => void;
}>;

/**
 * Uncontrolled metadata form. The screen remounts this component — keyed on the
 * metadata it seeds via `metadataFormKey` — so a refetch re-seeds both fields
 * only when that metadata changed; the refs live here, so the remount resets
 * them alongside the inputs.
 */
function ProfileMetadataForm({ profile, isSaving, onSave }: MetadataFormProps) {
  const { t } = useTranslation();
  const nameRef = useRef(profile.name);
  const descriptionRef = useRef(profile.description ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);

  const submit = () => {
    const name = nameRef.current.trim();
    const nameIssue = validateProfileName(name);
    if (nameIssue !== null) {
      setNameError(
        nameIssue === 'empty' ? t('profiles.nameRequired') : t('agentChat.newSession.nameTooLong')
      );
      return;
    }
    const description = descriptionRef.current.trim();
    if (validateProfileDescription(description) !== null) {
      setDescriptionError(t('agentChat.newSession.descriptionTooLong'));
      return;
    }
    setNameError(null);
    setDescriptionError(null);
    onSave({ name, description });
  };

  return (
    <View className="gap-4">
      <FormField
        label={t('profiles.nameLabel')}
        placeholder={t('profiles.namePlaceholder')}
        defaultValue={profile.name}
        error={nameError ?? undefined}
        disabled={isSaving}
        required
        returnKeyType="next"
        onChangeText={value => {
          nameRef.current = value;
          if (nameError !== null && validateProfileName(value) === null) {
            setNameError(null);
          }
        }}
      />
      <FormField
        label={t('profiles.descriptionLabel')}
        placeholder={t('profiles.descriptionPlaceholder')}
        defaultValue={profile.description ?? ''}
        error={descriptionError ?? undefined}
        multiline
        textAlignVertical="top"
        className="min-h-20 leading-5"
        disabled={isSaving}
        onChangeText={value => {
          descriptionRef.current = value;
          if (descriptionError !== null && validateProfileDescription(value) === null) {
            setDescriptionError(null);
          }
        }}
      />
      <Button loading={isSaving} disabled={isSaving} onPress={submit}>
        <Text>{t('common.save')}</Text>
      </Button>
    </View>
  );
}

export function ProfileOverviewScreen({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const profileQuery = useAgentProfile(profileId, organizationId);
  const { update, deleteProfile, setAsDefault, clearDefault } =
    useAgentProfileMutations(organizationId);

  const profile = profileQuery.data;
  const isOrgOwned = organizationId !== undefined;

  const saveMetadata = async ({ name, description }: { name: string; description: string }) => {
    try {
      await update.mutateAsync({ profileId, name, description });
      toast.success(t('common.updated'));
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.saveFailed'));
      }
    }
  };

  const runDelete = async (profileName: string) => {
    try {
      await deleteProfile.mutateAsync({ profileId });
      toast.success(t('profiles.deletedToast', { name: profileName }));
      router.back();
    } catch (error) {
      if (deleteErrorMessage(error) === 'blocked') {
        toast.error(t('profiles.deleteBlocked'));
      } else if (!hasUsableMessage(error)) {
        toast.error(t('profiles.deleteFailed'));
      }
    }
  };

  const confirmDelete = (profileName: string) => {
    Alert.alert(t('profiles.deleteTitle'), t('profiles.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void runDelete(profileName);
        },
      },
    ]);
  };

  const defaultPending = setAsDefault.isPending || clearDefault.isPending;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={profile?.name ?? t('profiles.title')} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {profileQuery.isError ? (
          <QueryError
            variant="server"
            placement="top"
            title={t('profiles.loadFailed')}
            onRetry={() => void profileQuery.refetch()}
            isRetrying={profileQuery.isRefetching}
          />
        ) : null}

        {!profileQuery.isError && profile === undefined ? <ProfileOverviewSkeleton /> : null}

        {!profileQuery.isError && profile !== undefined ? (
          <>
            <ProfileMetadataForm
              key={metadataFormKey(profile)}
              profile={profile}
              isSaving={update.isPending}
              onSave={values => {
                void saveMetadata(values);
              }}
            />

            <PreferenceRow
              icon={Star}
              title={t('profiles.defaultSectionTitle')}
              subtitle={t(defaultDescriptionKey(isOrgOwned))}
              value={profile.isDefault}
              disabled={defaultPending}
              busy={defaultPending}
              switchAccessibilityLabel={t(defaultControlLabel(profile.isDefault))}
              onValueChange={next => {
                if (next) {
                  setAsDefault.mutate({ profileId });
                } else {
                  clearDefault.mutate({ profileId });
                }
              }}
            />

            <ProfileRepoPinsSection profileId={profileId} organizationId={organizationId} />

            <View className="gap-1">
              <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
                {t('profiles.settingsSectionTitle')}
              </Text>
              <View>
                {overviewSectionRows(profile).map((row, index, rows) => (
                  <ConfigureRow
                    key={row.key}
                    icon={SECTION_ICONS[row.key]}
                    title={t(row.titleKey)}
                    subtitle={String(row.count)}
                    last={index === rows.length - 1}
                    onPress={() => {
                      router.push(SECTION_PATHS[row.key](profileId, organizationId));
                    }}
                  />
                ))}
              </View>
            </View>

            <Button
              variant="destructive"
              loading={deleteProfile.isPending}
              disabled={deleteProfile.isPending}
              onPress={() => {
                confirmDelete(profile.name);
              }}
            >
              <Trash2 size={16} color={colors.destructiveForeground} />
              <Text>{t('common.delete')}</Text>
            </Button>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
