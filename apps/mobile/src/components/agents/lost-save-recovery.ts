import {
  type ProfileSelectorOwnerType,
  type ProfileSelectorProfile,
} from '@/components/agents/profile-selector-model';

/**
 * The recovery model for a `Save as profile` whose response never arrived.
 *
 * The save is one atomic create, so a lost answer leaves the profile list as the
 * one record of whether it committed. A retry then collides on the owner's
 * profile-name constraint, and that collision has two readings: this flow's own
 * commit, or a profile that already carried the name before any attempt. The
 * ids the panel knew before the attempt separate the two, and only the first
 * reading may clear the person's draft.
 */

/**
 * The sentence `agentProfiles.create` answers with when the owner already holds
 * a profile of that name. Every other create refusal names a different fault.
 */
export const PROFILE_NAME_TAKEN_MESSAGE = 'A profile with this name already exists';

/** One environment variable a save submits, as the create sends it. */
type SaveContentVar = Readonly<{
  key: string;
  value: string;
  isSecret: boolean;
}>;

/** What one save submits beside its name: everything the stored profile must hold. */
export type SaveContent = Readonly<{
  vars: readonly SaveContentVar[];
  commands: readonly string[];
  setAsDefault: boolean;
  /**
   * The description as the create sends it: `undefined` when the sheet was left
   * blank, because the create omits an absent description instead of storing an
   * empty one. The recorded attempt and the retry both carry that same form, so
   * a description typed between the two never compares equal to the blank field
   * it replaced.
   */
  description: string | undefined;
}>;

/**
 * The last attempt whose response never arrived: the account it was made in,
 * what it submitted, and the ids that account held just before it.
 */
export type UnknownSaveAttempt = Readonly<{
  /** The account the attempt wrote into; `null` is Personal. */
  scope: string | null;
  name: string;
  knownIds: ReadonlySet<string>;
  content: SaveContent;
}>;

/**
 * Whether two saves submitted the same configuration.
 *
 * A row's identity alone does not prove the row holds what this attempt
 * submitted: a profile created by an unanswered attempt can be edited away, or
 * the person can change the draft before the retry, and adopting that row then
 * confirms a save whose content never reached the server. Commands are an
 * ordered list and compare as one; the default flag and the description are
 * single values, and the create stores the trimmed description it was sent, so
 * an edit to either between the two attempts is a different configuration; vars
 * compare as a set keyed by `key`, because the create stores them in the order
 * the client sent them and a reordered draft is the same configuration, while
 * a changed value or secret flag is not.
 */
function sameSaveContent(a: SaveContent, b: SaveContent): boolean {
  if (a.setAsDefault !== b.setAsDefault) {
    return false;
  }
  if (a.description !== b.description) {
    return false;
  }
  if (
    a.commands.length !== b.commands.length ||
    a.commands.some((command, index) => command !== b.commands[index])
  ) {
    return false;
  }
  const submitted = new Map(a.vars.map(variable => [variable.key, variable]));
  if (submitted.size !== a.vars.length || submitted.size !== b.vars.length) {
    return false;
  }
  return b.vars.every(variable => {
    const other = submitted.get(variable.key);
    return (
      other !== undefined && other.value === variable.value && other.isSecret === variable.isSecret
    );
  });
}

/** One list row this module reads: the description and the counts the saved profile reports. */
type RecoveryRow = Readonly<{
  id: string;
  name: string;
  description: string | null;
  varCount: number;
  commandCount: number;
  isDefault: boolean;
}>;

/** The combined list read: one bucket per owner, the shape an org context receives. */
type ProfileScopeData = Readonly<{
  orgProfiles: readonly RecoveryRow[];
  personalProfiles: readonly RecoveryRow[];
}>;

function isScopeData(data: readonly RecoveryRow[] | ProfileScopeData): data is ProfileScopeData {
  return 'orgProfiles' in data;
}

/**
 * The rows of the owner scope the panel saves into: the personal array, or the
 * organization bucket of the combined read.
 */
function scopeRowsOf(
  data: readonly RecoveryRow[] | ProfileScopeData,
  organizationId: string | undefined
): readonly RecoveryRow[] {
  if (!isScopeData(data)) {
    return data;
  }
  return organizationId === undefined ? data.personalProfiles : data.orgProfiles;
}

/** The ids one owner scope lists, the set a lost attempt's diff compares against. */
export function profileIds(rows: readonly RecoveryRow[]): ReadonlySet<string> {
  return new Set(rows.map(row => row.id));
}

/** The list read, the owner scope and the two contents a recovery compares. */
export type LostSaveQuery = Readonly<{
  data: readonly RecoveryRow[] | ProfileScopeData;
  organizationId: string | undefined;
  attempt: UnknownSaveAttempt;
  /** The content this save is sending now; a mismatch leaves the collision unrecovered. */
  retried: SaveContent;
}>;

/**
 * The profile a lost attempt created, or null when the collision belongs to
 * somebody else.
 *
 * The attempt counts only in the account it was made in. `knownIds` is that
 * account's own list before the write, so the record describes that account and
 * nothing else: `recoverLostSave` compares it with the same account's rows, and
 * returns nothing when the account differs. The account is therefore checked
 * before anything else.
 *
 * The id diff is what separates the two: a row with the submitted name that the
 * panel did not know before the attempt can only be there because a write landed
 * in between, so exactly one such row is that attempt's own commit. A row the
 * panel already knew is a real clash, not a recovered write, so the caller keeps
 * the draft.
 *
 * Identity is not enough on its own: the row itself must still hold what this
 * flow submitted. `retried` is the content this save is sending now, and a
 * mismatch there leaves the collision unrecovered, because a profile the lost
 * attempt created can have been edited since and confirming the save would
 * credit the person with content the stored profile does not hold. The same
 * holds after the retry agrees with the attempt: a row edited between the lost
 * write and the refetch reports the edited counts, so the row's own var count,
 * command count and default flag must match the attempt's content too. The
 * counts come from the refetched row, because the response that would have
 * carried them is the one that was lost, and the create stores the submitted
 * list as one unit, so a count that disagrees with the attempt is that row's own
 * evidence of a change made outside this flow.
 */
export function lostSaveProfile({
  data,
  organizationId,
  attempt,
  retried,
}: LostSaveQuery): ProfileSelectorProfile | null {
  if (attempt.scope !== (organizationId ?? null)) {
    return null;
  }
  if (!sameSaveContent(attempt.content, retried)) {
    return null;
  }
  const matches = scopeRowsOf(data, organizationId).filter(
    row => row.name.trim() === attempt.name && !attempt.knownIds.has(row.id)
  );
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) {
    return null;
  }
  // The row must still hold what the attempt submitted: the create stores the
  // submitted description, counts and default flag, so any of them disagreeing
  // with the submission is that row's own evidence of an edit made after the
  // lost write.
  if (
    (only.description ?? undefined) !== attempt.content.description ||
    only.varCount !== attempt.content.vars.length ||
    only.commandCount !== attempt.content.commands.length ||
    only.isDefault !== attempt.content.setAsDefault
  ) {
    return null;
  }
  const ownerType: ProfileSelectorOwnerType =
    organizationId === undefined ? 'user' : 'organization';
  return {
    id: only.id,
    name: only.name,
    varCount: only.varCount,
    commandCount: only.commandCount,
    isDefault: only.isDefault,
    ownerType,
  };
}
