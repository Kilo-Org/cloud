import { useMemo, useRef, useState } from 'react';
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
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useAgentProfileList, useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { draftProfileCountItems, formatProfileCountItems } from '@/lib/profile-count-labels';
import { cn } from '@/lib/utils';

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
  /**
   * Asks the host to scroll the shared composer so the expanded content comes
   * into view; the argument is this panel's top offset inside that scroll
   * content, measured from the panel's own layout. Reported once per
   * expansion, after the expanded block has laid out: the panel sits at the
   * bottom of a scroll body, so a scroll issued any earlier clamps against the
   * pre-expansion content height and moves nothing.
   */
  onRequestReveal?: (contentOffset: number) => void;
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
  onRequestReveal,
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
  // This panel's top inside the composer's scroll content, reported by its
  // root's layout. Expanding never moves anything above the disclosure row, so
  // the collapsed measurement still holds when the reveal is requested.
  const contentOffsetRef = useRef(0);
  // Set on expand, cleared by the reveal, so later in-panel layouts (a new
  // variable or command row) never scroll the composer under the reader again.
  const revealPendingRef = useRef(false);

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
  const profileSummary = useMemo(
    () =>
      formatProfileCountItems(t, draftProfileCountItems(effectiveVars, effectiveCommands)).join(
        ' · '
      ),
    [t, effectiveVars, effectiveCommands]
  );

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

  const toggleExpanded = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    revealPendingRef.current = next;
  };
  // The reveal runs from the expanded block's first layout, not from the tap:
  // the block is what grows the scroll content, and a scroll issued before that
  // layout clamps against the collapsed height and moves nothing.
  const handleExpandedLayout = () => {
    if (!revealPendingRef.current) {
      return;
    }
    revealPendingRef.current = false;
    onRequestReveal?.(contentOffsetRef.current);
  };

  return (
    <View
      className="mt-5"
      onLayout={event => {
        contentOffsetRef.current = event.nativeEvent.layout.y;
      }}
    >
      <Pressable
        className={cn(
          ROW_TARGET_CLASS,
          'flex-row items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2.5 active:opacity-70'
        )}
        onPress={toggleExpanded}
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
        // The revealed body is nested under the disclosure row it belongs to: a
        // start-side rule and one indent step keep its headings from reading as
        // the composer's own top-level sections. Logical properties, so the
        // nesting mirrors with the writing direction.
        <View className="mt-3 gap-4 border-s-2 border-border ps-3" onLayout={handleExpandedLayout}>
          <AccessibleStatus
            message={t('agentChat.newSession.advancedConfigDescription')}
            tone="status"
            className="text-xs"
          />

          {effectiveVars > 0 || effectiveCommands > 0 ? (
            <Text className="text-xs text-muted-foreground">{profileSummary}</Text>
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
