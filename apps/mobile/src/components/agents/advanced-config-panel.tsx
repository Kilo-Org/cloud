import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { type Href, useRouter } from 'expo-router';
import { toast } from 'sonner-native';

import {
  ManualEnvVarsEditor,
  ManualSetupCommandsEditor,
} from '@/components/agents/advanced-config-editors';
import {
  buildProfileSelectorState,
  type ProfileSelectorOwnerType,
  type ProfileSelectorProfile,
} from '@/components/agents/profile-selector-model';
import { ProfileSelectorRow } from '@/components/agents/profile-selector-row';
import {
  SaveProfileSheet,
  type SaveProfileSubmission,
} from '@/components/agents/save-profile-sheet';
import { type VariableEdit } from '@/components/profiles/profile-variables-model';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useAgentProfileList, useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const PROFILES_HREF = '/(app)/(tabs)/(3_profile)/profiles' as Href;

/** Structural view of a list row, so both the personal and combined shapes fit. */
type ProfileListRow = Readonly<{
  id: string;
  name: string;
  varCount: number;
  commandCount: number;
  isDefault: boolean;
  ownerType?: ProfileSelectorOwnerType;
}>;

function toSelectorProfile(
  profile: ProfileListRow,
  fallbackOwnerType: ProfileSelectorOwnerType
): ProfileSelectorProfile {
  return {
    id: profile.id,
    name: profile.name,
    varCount: profile.varCount,
    commandCount: profile.commandCount,
    isDefault: profile.isDefault,
    ownerType: profile.ownerType ?? fallbackOwnerType,
  };
}

type AdvancedConfigPanelProps = Readonly<{
  /** The route's organization scope; `undefined` is a personal session. */
  organizationId?: string;
  /**
   * The profile the session currently holds, or null for `No profile`. Owned
   * by the session body so the Environment row and this selector are one
   * control driving the submitted `profileId`. Required: a caller cannot
   * render an inert selector.
   */
  selectedProfileId: string | null;
  /** Reports a pick (or `No profile`) to the session that owns the override. */
  onSelectProfile: (id: string | null) => void;
  disabled?: boolean;
  /**
   * Opens the repo default-profile bindings. Omitted until that surface
   * exists, so the selector shows no dead `Default profiles for repos...`
   * entry.
   */
  onRepoDefaults?: () => void;
}>;

/**
 * The Advanced Configuration panel: a collapsed disclosure that expands to the
 * profile selector, the effective var/command summary, a manual environment
 * variables editor, a manual setup commands editor, and `Save as Profile` when
 * manual configuration exists. Mobile-first — plain tap rows and native
 * sheets, no JSON blob and no drag anywhere.
 */
export function AdvancedConfigPanel({
  organizationId,
  selectedProfileId,
  onSelectProfile,
  disabled = false,
  onRepoDefaults,
}: Readonly<AdvancedConfigPanelProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const list = useAgentProfileList(organizationId);
  const {
    create,
    setVar,
    setCommands: saveCommands,
    setAsDefault,
  } = useAgentProfileMutations(organizationId);

  const [isExpanded, setIsExpanded] = useState(false);
  const [createdProfile, setCreatedProfile] = useState<ProfileSelectorProfile | null>(null);
  const [draftVars, setDraftVars] = useState<VariableEdit[]>([]);
  const [commands, setCommands] = useState<string[]>([]);
  const [isSaveOpen, setIsSaveOpen] = useState(false);

  const orgProfiles = useMemo(() => {
    const base = (list.orgProfiles as readonly ProfileListRow[]).map(profile =>
      toSelectorProfile(profile, 'organization')
    );
    if (
      createdProfile?.ownerType === 'organization' &&
      !base.some(profile => profile.id === createdProfile.id)
    ) {
      return [...base, createdProfile];
    }
    return base;
  }, [list.orgProfiles, createdProfile]);

  const personalProfiles = useMemo(() => {
    const base = (list.personalProfiles as readonly ProfileListRow[]).map(profile =>
      toSelectorProfile(profile, 'user')
    );
    if (
      createdProfile?.ownerType === 'user' &&
      !base.some(profile => profile.id === createdProfile.id)
    ) {
      return [...base, createdProfile];
    }
    return base;
  }, [list.personalProfiles, createdProfile]);

  const selectorState = useMemo(
    () =>
      buildProfileSelectorState({
        organizationId,
        orgProfiles,
        personalProfiles,
        effectiveDefaultId: list.effectiveDefaultId,
        selectedProfileId,
        includeRepoDefaults: onRepoDefaults !== undefined,
      }),
    [
      organizationId,
      orgProfiles,
      personalProfiles,
      list.effectiveDefaultId,
      selectedProfileId,
      onRepoDefaults,
    ]
  );

  const selectedProfile = selectorState.selectedProfile;
  const manualCommands = commands.filter(command => command.trim().length > 0);
  const hasManualConfig = draftVars.length > 0 || commands.length > 0;
  const effectiveVars = (selectedProfile?.varCount ?? 0) + draftVars.length;
  const effectiveCommands = (selectedProfile?.commandCount ?? 0) + manualCommands.length;

  const handleSaveProfile = async (submission: SaveProfileSubmission): Promise<boolean> => {
    try {
      // Web's order: create the profile, then its vars (in parallel), then the
      // commands, then the default flag.
      const { id: profileId } = await create.mutateAsync({
        name: submission.name,
        description: submission.description === '' ? undefined : submission.description,
      });
      await Promise.all(
        draftVars.map(async variable => {
          await setVar.mutateAsync({
            profileId,
            key: variable.key,
            value: variable.value,
            isSecret: variable.isSecret,
          });
        })
      );
      if (manualCommands.length > 0) {
        await saveCommands.mutateAsync({ profileId, commands: manualCommands });
      }
      if (submission.setAsDefault) {
        await setAsDefault.mutateAsync({ profileId });
      }
      // Show the new profile immediately, before the invalidated list refetch
      // lands, so the selector never flashes back to "No profile".
      setCreatedProfile({
        id: profileId,
        name: submission.name,
        varCount: draftVars.length,
        commandCount: manualCommands.length,
        isDefault: submission.setAsDefault,
        ownerType: organizationId === undefined ? 'user' : 'organization',
      });
      onSelectProfile(profileId);
      toast.success(t('agentChat.newSession.profileSaved', { name: submission.name }));
      return true;
    } catch (error) {
      // The mutation hook already toasts a readable server message; only fill
      // in the fallback when the server sent nothing.
      if (!(error instanceof Error) || error.message.trim().length === 0) {
        toast.error(t('profiles.saveFailed'));
      }
      return false;
    }
  };

  return (
    <View className="mt-5">
      <Pressable
        className="min-h-11 flex-row items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2.5 active:opacity-70"
        onPress={() => {
          setIsExpanded(current => !current);
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.newSession.advancedConfig')}
        accessibilityState={{ expanded: isExpanded, disabled }}
      >
        <Text className="text-sm font-medium text-foreground">
          {t('agentChat.newSession.advancedConfig')}
        </Text>
        {isExpanded ? (
          <ChevronUp size={18} color={colors.mutedForeground} />
        ) : (
          <ChevronDown size={18} color={colors.mutedForeground} />
        )}
      </Pressable>

      {isExpanded ? (
        <View className="mt-3 gap-4">
          <Text className="text-xs text-muted-foreground">
            {t('agentChat.newSession.advancedConfigDescription')}
          </Text>

          <ProfileSelectorRow
            state={selectorState}
            isLoading={list.isLoading}
            isError={list.isError}
            disabled={disabled}
            onRetry={() => {
              void list.refetch();
            }}
            onSelect={onSelectProfile}
            onManageProfiles={() => {
              router.push(PROFILES_HREF);
            }}
            onRepoDefaults={onRepoDefaults}
          />

          {effectiveVars > 0 || effectiveCommands > 0 ? (
            <Text className="text-xs text-muted-foreground">
              {t('agentChat.newSession.profileSummary', {
                vars: effectiveVars,
                commands: effectiveCommands,
              })}
            </Text>
          ) : null}

          <ManualEnvVarsEditor vars={draftVars} disabled={disabled} onChange={setDraftVars} />
          <ManualSetupCommandsEditor
            commands={commands}
            disabled={disabled}
            onChange={setCommands}
          />

          {hasManualConfig ? (
            <Button
              onPress={() => {
                setIsSaveOpen(true);
              }}
              disabled={disabled}
              accessibilityLabel={t('agentChat.newSession.saveAsProfile')}
            >
              <Text>{t('agentChat.newSession.saveAsProfile')}</Text>
            </Button>
          ) : null}
        </View>
      ) : null}

      {isSaveOpen ? (
        <SaveProfileSheet
          envVars={draftVars}
          setupCommands={manualCommands}
          onClose={() => {
            setIsSaveOpen(false);
          }}
          onSave={handleSaveProfile}
        />
      ) : null}
    </View>
  );
}
