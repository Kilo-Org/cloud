import { describe, expect, it } from 'vitest';

import { lostSaveProfile, type SaveContent, type UnknownSaveAttempt } from './lost-save-recovery';
import { type ProfileSelectorProfile } from './profile-selector-model';

/**
 * What both attempts submit: one var and one command, non-default and no
 * description, which the recovered row must still hold.
 */
const CONTENT: SaveContent = {
  vars: [{ key: 'API_KEY', value: 'abc', isSecret: false }],
  commands: ['pnpm install'],
  setAsDefault: false,
  description: undefined,
};

/** One list row the recovery reads: the saved profile's own stored fields. */
type Row = Readonly<{
  id: string;
  name: string;
  description: string | null;
  varCount: number;
  commandCount: number;
  isDefault: boolean;
}>;

/** A row exactly as the create would have stored `CONTENT`. */
function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    name: 'My Setup',
    description: null,
    varCount: CONTENT.vars.length,
    commandCount: CONTENT.commands.length,
    isDefault: CONTENT.setAsDefault,
    ...overrides,
  };
}

/** A recorded attempt made in `scope`, knowing the rows in `knownIds`. */
function attempt(
  scope: string | null,
  knownIds: readonly string[] = ['known']
): UnknownSaveAttempt {
  return { scope, name: 'My Setup', knownIds: new Set(knownIds), content: CONTENT };
}

/** The row an unanswered attempt left behind, which a later collision adopts. */
const LOST_ROW = row({ id: 'new' });
/** A row the attempt's account already listed before the write. */
const KNOWN_ROW = row({ id: 'known' });

type Case = Readonly<{
  label: string;
  organizationId: string | undefined;
  attempt: UnknownSaveAttempt;
  data: readonly Row[] | { orgProfiles: readonly Row[]; personalProfiles: readonly Row[] };
  expected: ProfileSelectorProfile | null;
}>;

function recovered(ownerType: ProfileSelectorProfile['ownerType']): ProfileSelectorProfile {
  return {
    id: LOST_ROW.id,
    name: LOST_ROW.name,
    varCount: LOST_ROW.varCount,
    commandCount: LOST_ROW.commandCount,
    isDefault: LOST_ROW.isDefault,
    ownerType,
  };
}

// The account guard is not an always-deny: the attempt's own account recovers
// the row it created, and only another account refuses to read the record.
const CASES: readonly Case[] = [
  {
    label: 'recovers the row in the Personal account that recorded the attempt',
    organizationId: undefined,
    attempt: attempt(null),
    data: [KNOWN_ROW, LOST_ROW],
    expected: recovered('user'),
  },
  {
    label: 'recovers the row in the organization that recorded the attempt',
    organizationId: 'org-1',
    attempt: attempt('org-1', ['org-known']),
    data: {
      orgProfiles: [row({ id: 'org-known' }), row({ id: 'org-new' })],
      personalProfiles: [],
    },
    expected: { ...recovered('organization'), id: 'org-new' },
  },
  {
    label: 'recovers a Personal attempt from the personal bucket of a combined read',
    organizationId: undefined,
    attempt: attempt(null),
    data: { orgProfiles: [], personalProfiles: [LOST_ROW] },
    expected: recovered('user'),
  },
  {
    label: 'refuses an attempt recorded in another organization',
    organizationId: 'org-1',
    attempt: attempt('org-2', ['org-known']),
    data: { orgProfiles: [row({ id: 'org-new' })], personalProfiles: [] },
    expected: null,
  },
  {
    label: 'refuses an organization attempt read in a Personal session',
    organizationId: undefined,
    attempt: attempt('org-1', ['org-known']),
    data: [LOST_ROW],
    expected: null,
  },
  {
    label: 'refuses a Personal attempt read in an organization session',
    organizationId: 'org-1',
    attempt: attempt(null),
    // The matching row sits in the personal bucket the organization read also
    // carries, so only the account guard can refuse it.
    data: { orgProfiles: [], personalProfiles: [LOST_ROW] },
    expected: null,
  },
  {
    label: 'refuses a row the attempt already knew, so a real clash keeps the draft',
    organizationId: undefined,
    attempt: attempt(null),
    data: [KNOWN_ROW],
    expected: null,
  },
];

describe('lostSaveProfile', () => {
  it.each(CASES)('$label', ({ organizationId, attempt: recorded, data, expected }) => {
    expect(lostSaveProfile({ data, organizationId, attempt: recorded, retried: CONTENT })).toEqual(
      expected
    );
  });
});
