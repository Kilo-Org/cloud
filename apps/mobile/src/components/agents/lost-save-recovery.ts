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

/** The last attempt whose response never arrived, and the ids that scope held just before it. */
export type UnknownSaveAttempt = Readonly<{
  name: string;
  knownIds: ReadonlySet<string>;
}>;

/** One list row this module reads: the counts the saved profile reports. */
type RecoveryRow = Readonly<{
  id: string;
  name: string;
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

/**
 * The profile a lost attempt created, or null when the collision belongs to
 * somebody else.
 *
 * The id diff is what separates the two: a row with the submitted name that the
 * panel did not know before the attempt can only be there because a write landed
 * in between, so exactly one such row is that attempt's own commit. A row the
 * panel already knew is a real clash, not a recovered write, so the caller keeps
 * the draft. The counts come from the refetched row, because the response that
 * would have carried them is the one that was lost and the list is the server's
 * own record.
 */
export function lostSaveProfile(
  data: readonly RecoveryRow[] | ProfileScopeData,
  organizationId: string | undefined,
  attempt: UnknownSaveAttempt
): ProfileSelectorProfile | null {
  const matches = scopeRowsOf(data, organizationId).filter(
    row => row.name.trim() === attempt.name && !attempt.knownIds.has(row.id)
  );
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) {
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
