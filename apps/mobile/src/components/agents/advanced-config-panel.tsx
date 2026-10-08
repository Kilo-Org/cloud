import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
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
   * The session's profile override, or null to use the effective default.
   * Used for the resource summary; the Environment row owns profile selection.
   */
  selectedProfileId: string | null;
  /** Selects the profile created by saving the manual configuration. */
  onSelectProfile: (id: string | null) => void;
  /**
   * The session's manual environment variables and setup commands, owned by the
   * new-session route so the create can carry them. The panel edits them through
   * the callbacks and keeps no draft of its own, so a value entered here is
   * never dropped when the session starts without saving a profile first.
   * Saving them as a profile clears both, because the profile now carries them.
   */
  manualVars: readonly VariableEdit[];
  manualCommands: readonly string[];
  onManualVarsChange: (next: VariableEdit[]) => void;
  onManualCommandsChange: (next: string[]) => void;
  disabled?: boolean;
  /** Opens the repo default-profile bindings when that surface is available. */
  onRepoDefaults?: () => void;
}>;

/**
 * The Advanced Configuration panel: a collapsed disclosure that expands to the
 * effective var/command summary, a manual environment variables editor,
 * a manual setup commands editor, and `Save as Profile` when
 * manual configuration exists. Mobile-first — plain tap rows and native
 * sheets, no JSON blob and no drag anywhere.
 */
export function AdvancedConfigPanel({
  organizationId,
  selectedProfileId,
  onSelectProfile,
  manualVars,
  manualCommands,
  onManualVarsChange,
  onManualCommandsChange,
  disabled = false,
  onRepoDefaults,
}: Readonly<AdvancedConfigPanelProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const list = useAgentProfileList(organizationId);
  const {
    create,
    setVar,
    setCommands: saveCommands,
    setAsDefault,
  } = useAgentProfileMutations(organizationId);

  const [isExpanded, setIsExpanded] = useState(false);
  const [createdProfile, setCreatedProfile] = useState<ProfileSelectorProfile | null>(null);
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
      }),
    [organizationId, orgProfiles, personalProfiles, list.effectiveDefaultId, selectedProfileId]
  );

  const selectedProfile = selectorState.selectedProfile;
  const setupCommands = manualCommands.filter(command => command.trim().length > 0);
  const hasManualConfig = manualVars.length > 0 || setupCommands.length > 0;
  const effectiveVars = (selectedProfile?.varCount ?? 0) + manualVars.length;
  const effectiveCommands = (selectedProfile?.commandCount ?? 0) + setupCommands.length;

  const handleSaveProfile = async (submission: SaveProfileSubmission): Promise<boolean> => {
    try {
      // Web's order: create the profile, then its vars (in parallel), then the
      // commands, then the default flag.
      const { id: profileId } = await create.mutateAsync({
        name: submission.name,
        description: submission.description === '' ? undefined : submission.description,
      });
      await Promise.all(
        manualVars.map(async variable => {
          await setVar.mutateAsync({
            profileId,
            key: variable.key,
            value: variable.value,
            isSecret: variable.isSecret,
          });
        })
      );
      if (setupCommands.length > 0) {
        await saveCommands.mutateAsync({ profileId, commands: setupCommands });
      }
      if (submission.setAsDefault) {
        await setAsDefault.mutateAsync({ profileId });
      }
      // Keep resource counts current before the invalidated list refetch lands.
      setCreatedProfile({
        id: profileId,
        name: submission.name,
        varCount: manualVars.length,
        commandCount: setupCommands.length,
        isDefault: submission.setAsDefault,
        ownerType: organizationId === undefined ? 'user' : 'organization',
      });
      onSelectProfile(profileId);
      // The saved profile now carries these values, so the draft must not stay
      // behind: the profile's setup commands are appended to the inline ones,
      // and leaving the draft populated would run every saved command twice.
      onManualVarsChange([]);
      onManualCommandsChange([]);
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

          {effectiveVars > 0 || effectiveCommands > 0 ? (
            <Text className="text-xs text-muted-foreground">
              {t('agentChat.newSession.profileSummary', {
                vars: effectiveVars,
                commands: effectiveCommands,
              })}
            </Text>
          ) : null}

          <ManualEnvVarsEditor
            vars={manualVars}
            disabled={disabled}
            onChange={onManualVarsChange}
          />
          <ManualSetupCommandsEditor
            commands={manualCommands}
            disabled={disabled}
            onChange={onManualCommandsChange}
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
          {onRepoDefaults ? (
            <Button
              variant="outline"
              onPress={onRepoDefaults}
              disabled={disabled}
              accessibilityLabel={t('profiles.repoBindings.title')}
            >
              <Text>{t('profiles.repoBindings.title')}</Text>
            </Button>
          ) : null}
        </View>
      ) : null}

      {isSaveOpen ? (
        <SaveProfileSheet
          envVars={manualVars}
          setupCommands={setupCommands}
          onClose={() => {
            setIsSaveOpen(false);
          }}
          onSave={handleSaveProfile}
        />
      ) : null}
    </View>
  );
}
