import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import {
  lostSaveProfile,
  PROFILE_NAME_TAKEN_MESSAGE,
  profileIds,
  type SaveContent,
  type UnknownSaveAttempt,
} from '@/components/agents/lost-save-recovery';
import { profileSaveCreateInput } from '@/components/agents/profile-save-request';
import { type ProfileSelectorProfile } from '@/components/agents/profile-selector-model';
import {
  type SaveProfileOutcome,
  type SaveProfileSubmission,
} from '@/components/agents/save-profile-sheet';
import { type VariableEdit } from '@/components/profiles/profile-variables-model';
import { useAgentProfileList, useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { readTrpcServerMessage } from '@/lib/trpc-error';

/**
 * What this panel has written into one account: the profile a completed save
 * published, and the last attempt whose response never arrived. The tag is the
 * account the payload was produced in (`null` is Personal), so a render reads a
 * payload only while its tag matches the live account: an account's row and
 * attempt are never offered to another one.
 */
type ScopedSaveRecord = Readonly<{
  scope: string | null;
  savedProfile: ProfileSelectorProfile | null;
  lostAttempt: UnknownSaveAttempt | null;
}>;

/**
 * Read in place of a record produced in another account. Only its empty payload
 * is ever read, never its tag: an organization answer must not appear in
 * Personal and a Personal one must not appear in an organization.
 */
const NO_SAVE_RECORD: ScopedSaveRecord = {
  scope: null,
  savedProfile: null,
  lostAttempt: null,
};

export type AgentProfileSaveInputs = Readonly<{
  /** The route's organization scope; `undefined` is a personal session. */
  organizationId: string | undefined;
  /** The manual environment variables the save submits. */
  manualVars: readonly VariableEdit[];
  /** The manual setup commands the save submits. */
  setupCommands: readonly string[];
  /** Selects the profile a completed save created. */
  onSelectProfile: (id: string | null) => void;
  /** Clears the manual draft the saved profile now carries. */
  onManualVarsChange: (vars: VariableEdit[]) => void;
  onManualCommandsChange: (commands: string[]) => void;
}>;

export type AgentProfileSave = Readonly<{
  /** The account's profile list, read once here so the panel renders it. */
  list: ReturnType<typeof useAgentProfileList>;
  /** The row a completed save published, while it belongs to the live account. */
  savedProfile: ProfileSelectorProfile | null;
  handleSaveProfile: (submission: SaveProfileSubmission) => Promise<SaveProfileOutcome>;
}>;

/**
 * The `Save as profile` write for the Advanced Configuration panel: one atomic
 * create whose answer either completes the save, is refused with the server's
 * sentence, or never arrives.
 *
 * Every write into the record is an event or an async transition that carries
 * the account it was produced in, and every read is derived from the live
 * account instead of being reset when that account moves. A render React throws
 * away therefore drops nothing: the record still describes the account that
 * produced it, and the next committed render reads it by tag.
 */
export function useAgentProfileSave({
  organizationId,
  manualVars,
  setupCommands,
  onSelectProfile,
  onManualVarsChange,
  onManualCommandsChange,
}: AgentProfileSaveInputs): AgentProfileSave {
  const { t } = useTranslation();
  const list = useAgentProfileList(organizationId);
  // The save's refusal is stated by the open sheet, so the create must not also
  // toast it: one failure surface, one sentence.
  const { create } = useAgentProfileMutations(organizationId, { quietCreateErrorToast: true });

  // The account this panel saves into. `null` is Personal, so it never shares a
  // key with an organization; the rows themselves are keyed by
  // `useAgentProfileList`, which starts empty for a different account.
  const scope = organizationId ?? null;
  const [storedRecord, setStoredRecord] = useState<ScopedSaveRecord>(() => ({
    scope: organizationId ?? null,
    savedProfile: null,
    lostAttempt: null,
  }));
  // Read after an `await`: a save publishes only into the account it started in.
  // Written during render rather than from a passive effect, because a save
  // settles in a microtask that can run before that effect does, and the effect
  // would still hold the previous account when the settlement reads it.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const record = storedRecord.scope === scope ? storedRecord : NO_SAVE_RECORD;
  const savedProfile = record.savedProfile;
  const lostAttempt = record.lostAttempt;

  /**
   * Complete a save for `profile`, whose account is `savedUnder`. The saved
   * profile is the draft's new home, so the two must not disagree: the profile's
   * setup commands are appended to the inline ones, and a draft left behind
   * would run them twice.
   */
  const finishSave = (profile: ProfileSelectorProfile, savedUnder: string | null) => {
    setStoredRecord({ scope: savedUnder, savedProfile: profile, lostAttempt: null });
    toast.success(t('agentChat.newSession.profileSaved', { name: profile.name }));
    // A profile belongs to the account it was created in. A save that completes
    // after the account moved publishes nothing here: the form keeps the
    // configuration it holds, and the new account's picks come only from its own
    // list.
    if (savedUnder !== scopeRef.current) {
      return;
    }
    // Keep resource counts current before the invalidated list refetch lands.
    onSelectProfile(profile.id);
    onManualVarsChange([]);
    onManualCommandsChange([]);
  };

  /**
   * The profile a lost attempt created, or null when the collision belongs to
   * somebody else. The list is the server's own record of the write, so only a
   * refetched row counts; see `lostSaveProfile` for why the id diff and the
   * submitted content both decide, and why the attempt counts only in the
   * account it was made in.
   */
  const recoverLostSave = async (
    name: string,
    retried: SaveContent
  ): Promise<ProfileSelectorProfile | null> => {
    const attempt = lostAttempt;
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
    // The account this save writes into, recorded so its result publishes only
    // into that account.
    const savedUnder = scope;
    // The server compares the trimmed name against the stored one, so every
    // reading here uses the trimmed form too.
    const name = submission.name.trim();
    // A recorded attempt belongs to the name it submitted: a corrected name
    // drops it, so a later collision cannot be credited to the old one.
    if (lostAttempt !== null && lostAttempt.name !== name) {
      setStoredRecord(previous =>
        previous.scope === savedUnder ? { ...previous, lostAttempt: null } : previous
      );
    }
    // The ids this owner scope holds before the write leaves. The diff against
    // the rows a lost attempt leaves behind is the one evidence that separates
    // that attempt's own commit from a profile which already had the name.
    const knownIds = profileIds(
      organizationId === undefined ? list.personalProfiles : list.orgProfiles
    );
    // What this save submits beside its name. A lost attempt records it so a
    // later collision can compare the row against the configuration this flow
    // actually sent, not just against the name and an unknown id. The
    // description enters in the form the create sends: an empty field is
    // `undefined`, so a description typed between the two attempts never
    // compares equal to the blank one it replaced.
    const content: SaveContent = {
      vars: manualVars.map(variable => ({
        key: variable.key,
        value: variable.value,
        isSecret: variable.isSecret,
      })),
      commands: setupCommands,
      setAsDefault: submission.setAsDefault,
      description: submission.description === '' ? undefined : submission.description,
    };
    try {
      // One server write: the profile, its vars, its commands and the default
      // flag commit together, so a refusal leaves nothing behind and a retry
      // cannot create a second profile holding only part of the config.
      const { id: profileId } = await create.mutateAsync(
        profileSaveCreateInput({ vars: manualVars, commands: setupCommands, submission, name })
      );
      finishSave(
        {
          id: profileId,
          name,
          varCount: manualVars.length,
          commandCount: setupCommands.length,
          isDefault: submission.setAsDefault,
          ownerType: organizationId === undefined ? 'user' : 'organization',
        },
        savedUnder
      );
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
          finishSave(recovered, savedUnder);
          return { saved: true };
        }
      }
      // No answer arrived, so this attempt may have committed: remember the
      // account it wrote into, what it submitted and what that account held
      // before it, for a later collision. `recoverLostSave` reads the record only
      // in that account, and the record keeps the saved row only while the tag
      // still names it.
      if (refusal === '') {
        setStoredRecord(previous => ({
          scope: savedUnder,
          savedProfile: previous.scope === savedUnder ? previous.savedProfile : null,
          lostAttempt: { scope: savedUnder, name, knownIds, content },
        }));
      }
      return { saved: false, refusal: refusal === '' ? null : refusal };
    }
  };

  return { list, savedProfile, handleSaveProfile };
}
