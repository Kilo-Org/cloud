import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import {
  ManualEnvVarsEditor,
  ManualSetupCommandsEditor,
} from '@/components/agents/advanced-config-editors';
import {
  lostSaveProfile,
  PROFILE_NAME_TAKEN_MESSAGE,
  profileIds,
  type SaveContent,
  type UnknownSaveAttempt,
} from '@/components/agents/lost-save-recovery';
import { type ProfileListRow, toSelectorProfile } from '@/components/agents/profile-list-row';
import { profileSaveCreateInput } from '@/components/agents/profile-save-request';
import {
  buildProfileSelectorState,
  type ProfileSelectorProfile,
} from '@/components/agents/profile-selector-model';
import {
  type SaveProfileOutcome,
  SaveProfileSheet,
  type SaveProfileSubmission,
} from '@/components/agents/save-profile-sheet';
import { type VariableEdit } from '@/components/profiles/profile-variables-model';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useAgentProfileList, useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { draftProfileCountItems, formatProfileCountItems } from '@/lib/profile-count-labels';
import { readTrpcServerMessage } from '@/lib/trpc-error';
import { cn } from '@/lib/utils';

type AdvancedConfigPanelProps = Readonly<{
  /** The route's organization scope; `undefined` is a personal session. */
  organizationId?: string;
  /**
   * The pick this session will run on, or null when nothing picked resolves.
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
 * a manual setup commands editor, and `Save as profile` when
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
  // The save's refusal is stated by the open sheet, so the create must not also
  // toast it: one failure surface, one sentence.
  const { create } = useAgentProfileMutations(organizationId, { quietCreateErrorToast: true });

  const [isExpanded, setIsExpanded] = useState(false);
  const [createdProfile, setCreatedProfile] = useState<ProfileSelectorProfile | null>(null);
  const [saveSheetInstance, setSaveSheetInstance] = useState<number | null>(null);
  // Open-instance ownership: a late settlement from a sheet that has since
  // been closed and reopened must not close the one that replaced it.
  const saveSheetInstanceRef = useRef(0);
  const openSaveSheet = () => {
    saveSheetInstanceRef.current += 1;
    setSaveSheetInstance(saveSheetInstanceRef.current);
  };
  const closeSaveSheet = (instance: number) => {
    if (saveSheetInstanceRef.current === instance) {
      setSaveSheetInstance(null);
    }
  };
  // This panel's top inside the composer's scroll content, reported by its
  // root's layout. Expanding never moves anything above the disclosure row, so
  // the collapsed measurement still holds when the reveal is requested.
  const contentOffsetRef = useRef(0);
  // Set on expand, cleared by the reveal, so later in-panel layouts (a new
  // variable or command row) never scroll the composer under the reader again.
  const revealPendingRef = useRef(false);
  // The last attempt whose response never arrived. A retry that collides on the
  // name can then tell this flow's own commit from a profile that already held
  // it, because only the former appears as an id the panel did not know.
  const lostSaveAttemptRef = useRef<UnknownSaveAttempt | null>(null);

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

  /**
   * Complete a save for `profile`: record it for the selector, pick it, and
   * clear the manual draft it now carries. The saved profile is the draft's new
   * home, so the two must not disagree: the profile's setup commands are
   * appended to the inline ones, and a draft left behind would run them twice.
   */
  const finishSave = (profile: ProfileSelectorProfile) => {
    lostSaveAttemptRef.current = null;
    // Keep resource counts current before the invalidated list refetch lands.
    setCreatedProfile(profile);
    onSelectProfile(profile.id);
    onManualVarsChange([]);
    onManualCommandsChange([]);
    toast.success(t('agentChat.newSession.profileSaved', { name: profile.name }));
  };

  /**
   * The profile a lost attempt created, or null when the collision belongs to
   * somebody else. The list is the server's own record of the write, so only a
   * refetched row counts; see `lostSaveProfile` for why the id diff and the
   * submitted content both decide.
   */
  const recoverLostSave = async (
    name: string,
    retried: SaveContent
  ): Promise<ProfileSelectorProfile | null> => {
    const attempt = lostSaveAttemptRef.current;
    if (attempt === null || attempt.name !== name) {
      return null;
    }
    const refetched = await list.refetch();
    if (refetched.data === undefined) {
      return null;
    }
    return lostSaveProfile({ data: refetched.data, organizationId, attempt, retried });
  };

  const handleSaveProfile = async (
    submission: SaveProfileSubmission
  ): Promise<SaveProfileOutcome> => {
    // The server compares the trimmed name against the stored one, so every
    // reading here uses the trimmed form too.
    const name = submission.name.trim();
    // A recorded attempt belongs to the name it submitted: a corrected name
    // drops it, so a later collision cannot be credited to the old one.
    if (lostSaveAttemptRef.current !== null && lostSaveAttemptRef.current.name !== name) {
      lostSaveAttemptRef.current = null;
    }
    // The ids this owner scope holds before the write leaves. The diff against
    // the rows a lost attempt leaves behind is the one evidence that separates
    // that attempt's own commit from a profile which already had the name.
    const knownIds = profileIds(
      organizationId === undefined ? list.personalProfiles : list.orgProfiles
    );
    // What this save submits beside its name. A lost attempt records it so a
    // later collision can compare the row against the configuration this flow
    // actually sent, not just against the name and an unknown id.
    const content: SaveContent = {
      vars: manualVars.map(variable => ({
        key: variable.key,
        value: variable.value,
        isSecret: variable.isSecret,
      })),
      commands: setupCommands,
      setAsDefault: submission.setAsDefault,
    };
    try {
      // One server write: the profile, its vars, its commands and the default
      // flag commit together, so a refusal leaves nothing behind and a retry
      // cannot create a second profile holding only part of the config.
      const { id: profileId } = await create.mutateAsync(
        profileSaveCreateInput({ vars: manualVars, commands: setupCommands, submission, name })
      );
      finishSave({
        id: profileId,
        name,
        varCount: manualVars.length,
        commandCount: setupCommands.length,
        isDefault: submission.setAsDefault,
        ownerType: organizationId === undefined ? 'user' : 'organization',
      });
      return { saved: true };
    } catch (error) {
      // The open sheet is this flow's only failure surface, so the hook's error
      // toast is off and nothing is toasted here: the sheet states the server's
      // sentence when the server wrote one, and its own neutral line when the
      // envelope carries none.
      //
      // Only a server answer carries a sentence. The transport wrappers are named
      // TRPCClientError too but carry no payload, so a timeout or a lost connection
      // reaches the person as the neutral line rather than engineering text.
      const refusal = readTrpcServerMessage(error)?.trim() ?? '';
      // A duplicate name after a lost attempt can be that attempt's own commit:
      // the retry collided with the profile the unanswered write already stored.
      // Only a row this panel did not know may complete the save, so a name that
      // was genuinely taken keeps the draft with the person.
      if (refusal === PROFILE_NAME_TAKEN_MESSAGE) {
        const recovered = await recoverLostSave(name, content);
        if (recovered !== null) {
          finishSave(recovered);
          return { saved: true };
        }
      }
      // No answer arrived, so this attempt may have committed: remember what it
      // submitted and what the scope held before it, for a later collision.
      if (refusal === '') {
        lostSaveAttemptRef.current = { name, knownIds, content };
      }
      return { saved: false, refusal: refusal === '' ? null : refusal };
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
      testID="advanced-config-panel"
      onLayout={event => {
        contentOffsetRef.current = event.nativeEvent.layout.y;
      }}
    >
      <RowGroup>
        <Pressable
          className={cn(
            ROW_TARGET_CLASS,
            'flex-row items-center justify-between gap-3 px-4 py-3 active:opacity-70'
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
          {/* A disclosure caret, not a navigation chevron: it names the state of
              the block under the row. */}
          {isExpanded ? (
            <ChevronUp size={16} color={colors.mutedForeground} />
          ) : (
            <ChevronDown size={16} color={colors.mutedForeground} />
          )}
        </Pressable>
      </RowGroup>

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
            <Text variant="caption">{profileSummary}</Text>
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
              onPress={openSaveSheet}
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

      {saveSheetInstance !== null ? (
        <SaveProfileSheet
          key={saveSheetInstance}
          envVars={manualVars}
          setupCommands={setupCommands}
          onClose={() => {
            closeSaveSheet(saveSheetInstance);
          }}
          onSave={handleSaveProfile}
        />
      ) : null}
    </View>
  );
}
