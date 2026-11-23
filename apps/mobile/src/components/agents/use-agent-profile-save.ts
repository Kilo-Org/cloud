import { useEffect, useRef, useState } from 'react';
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
 * The profile a completed save published, tagged with the account that received
 * it (`null` is Personal). Only one row is held at a time, and a render reads it
 * only while the tag names the account on screen.
 */
type PublishedRow = Readonly<{
  scope: string | null;
  profile: ProfileSelectorProfile;
}>;

/**
 * The attempts whose response never arrived, keyed by the account the payload
 * was produced in (`null` is Personal), so a write in one account never
 * replaces another account's attempt and a render reads only the live account's
 * own entry.
 */
type LostAttempts = ReadonlyMap<string | null, UnknownSaveAttempt>;

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
 * Two states live here, and each is read only for the account it was produced
 * in. The published row is a single row, dropped when the panel commits a move
 * to another account: a profile saved in one account may be deleted before the
 * panel returns to it, and holding the row would hide the account on screen's
 * own counts until its list lands. The lost attempts are kept per account, so
 * leaving an account neither discards the evidence about a write made there nor
 * offers it to another account.
 *
 * A render React throws away therefore drops nothing: the row still carries the
 * account that produced it, and the next committed render reads the live
 * account's own entries.
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
  // A completed save publishes at most one row, and only into the account that
  // received it: the row carries its own tag, so a render for another account
  // never reads it.
  const [publishedRow, setPublishedRow] = useState<PublishedRow | null>(null);
  // A lost attempt is evidence about a write made in one account, so it is kept
  // per account rather than dropped when the panel moves: the person can leave
  // an account, come back, and still have a retry converge on the write the
  // unanswered response created.
  const [lostAttempts, setLostAttempts] = useState<LostAttempts>(() => new Map());
  // Read after an `await`: a save publishes only into the account it started in.
  // Written during render rather than from a passive effect, because a save
  // settles in a microtask that can run before that effect does, and the effect
  // would still hold the previous account when the settlement reads it.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  // The published row describes one visit to one account, so the committed
  // transition away from that account drops it: a profile saved in A may be
  // deleted by the time the panel returns to A, and the row would hide the
  // account on screen's own counts until its list lands. Returning `row`
  // unchanged while the tag names the live account is what keeps this effect
  // from running on its own publish.
  //
  // A lost attempt is not dropped here: it describes the account it was made in
  // and belongs to that account alone, so leaving and returning keeps it.
  //
  // The reads below still derive from the live tag during render, so the frame
  // between the move and this effect reads no row on its own, and no state is
  // written during render.
  useEffect(() => {
    setPublishedRow(row => (row === null || row.scope === scope ? row : null));
  }, [scope]);

  const savedProfile = publishedRow?.scope === scope ? publishedRow.profile : null;
  const lostAttempt = lostAttempts.get(scope) ?? null;

  /**
   * Complete a save for `profile`, whose account is `savedUnder`. The saved
   * profile is the draft's new home, so the two must not disagree: the profile's
   * setup commands are appended to the inline ones, and a draft left behind
   * would run them twice.
   */
  const finishSave = (profile: ProfileSelectorProfile, savedUnder: string | null) => {
    // The confirmation describes a write this panel made in the account that
    // received it, so it is not withheld once the account on screen has moved.
    toast.success(t('agentChat.newSession.profileSaved', { name: profile.name }));
    // A profile belongs to the account it was created in. A save that completes
    // after the account moved publishes nothing here: the form keeps the
    // configuration it holds, and the new account's picks come only from its own
    // list.
    if (savedUnder !== scopeRef.current) {
      return;
    }
    // Only the live account publishes a row. A settlement for an account the
    // panel has left would replace the row the account on screen owns, hiding
    // its summary until the invalidated list refetch lands.
    setPublishedRow({ scope: savedUnder, profile });
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
      setLostAttempts(previous => {
        const next = new Map(previous);
        next.delete(savedUnder);
        return next;
      });
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
      // before it, for a later collision. The entry is keyed by that account, so
      // a settlement into an account the panel has left stays there instead of
      // replacing another account's row or attempt.
      if (refusal === '') {
        setLostAttempts(previous =>
          new Map(previous).set(savedUnder, { scope: savedUnder, name, knownIds, content })
        );
      }
      return { saved: false, refusal: refusal === '' ? null : refusal };
    }
  };

  return { list, savedProfile, handleSaveProfile };
}
