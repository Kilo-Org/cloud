import type { WorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { findAttributionIdentityRefusal } from './attribution-identity';

const USER_ID = 'user-123';
const ORGANIZATION_ID = 'org-123';

type AccountRow = {
  blockedAt: string | null;
  blockedReason: string | null;
  apiTokenPepper: string | null;
};

/**
 * Stands in for the two reads the rule makes: the account row from `kilocode_users`, and
 * the membership row that `isOrganizationMember` resolves. A missing membership row is
 * what a removed member, a never-member and a soft-deleted organization all look like.
 */
function database(rows: { account?: AccountRow[]; membership?: { role: string }[] }) {
  const select = () => ({
    from: (table: unknown) => {
      const selected = table === kilocode_users ? (rows.account ?? []) : (rows.membership ?? []);
      const limit = async () => selected;
      return {
        where: () => ({ limit }),
        innerJoin: () => ({ where: () => ({ limit }) }),
      };
    },
  });
  return { select } as unknown as Pick<WorkerDb, 'select'>;
}

const activeMember = (pepper: string | null): AccountRow[] => [
  { blockedAt: null, blockedReason: null, apiTokenPepper: pepper },
];

function claims(apiTokenPepper: string | null | undefined) {
  return { kiloUserId: USER_ID, organizationId: ORGANIZATION_ID, apiTokenPepper };
}

describe('findAttributionIdentityRefusal', () => {
  it('admits an active member of the claimed organization', async () => {
    const db = database({
      account: activeMember('pepper-current'),
      membership: [{ role: 'member' }],
    });

    await expect(findAttributionIdentityRefusal(db, claims('pepper-current'))).resolves.toBeNull();
  });

  it('refuses a token whose pepper is not the account pepper', async () => {
    const db = database({
      account: activeMember('pepper-current'),
      membership: [{ role: 'member' }],
    });

    await expect(findAttributionIdentityRefusal(db, claims('pepper-previous'))).resolves.toBe(
      'credential_stale'
    );
  });

  it('admits a token that carries no pepper claim, as an internal service token does', async () => {
    const db = database({
      account: activeMember('pepper-current'),
      membership: [{ role: 'member' }],
    });

    await expect(findAttributionIdentityRefusal(db, claims(undefined))).resolves.toBeNull();
  });

  it('refuses a null claim against an account that holds a pepper', async () => {
    const db = database({
      account: activeMember('pepper-current'),
      membership: [{ role: 'member' }],
    });

    await expect(findAttributionIdentityRefusal(db, claims(null))).resolves.toBe(
      'credential_stale'
    );
  });

  it('admits a null claim against an account without a pepper', async () => {
    const db = database({ account: activeMember(null), membership: [{ role: 'member' }] });

    await expect(findAttributionIdentityRefusal(db, claims(null))).resolves.toBeNull();
  });

  it('reports the credential before the membership lookup', async () => {
    const db = database({ account: activeMember('pepper-current'), membership: [] });

    await expect(findAttributionIdentityRefusal(db, claims('pepper-previous'))).resolves.toBe(
      'credential_stale'
    );
  });

  it.each([
    [
      'a recorded block time',
      { blockedAt: '2026-10-31T00:00:00.000Z', blockedReason: null, apiTokenPepper: null },
    ],
    ['a recorded block reason', { blockedAt: null, blockedReason: 'abuse', apiTokenPepper: null }],
  ])('refuses an account with %s', async (_label, account) => {
    const db = database({ account: [account], membership: [{ role: 'member' }] });

    await expect(findAttributionIdentityRefusal(db, claims(null))).resolves.toBe(
      'identity_blocked'
    );
  });

  it('refuses an identity with no account row', async () => {
    const db = database({ account: [], membership: [{ role: 'member' }] });

    await expect(findAttributionIdentityRefusal(db, claims('pepper-current'))).resolves.toBe(
      'identity_missing'
    );
  });

  it('refuses an active account with no membership row for the claimed organization', async () => {
    const db = database({ account: activeMember('pepper-current'), membership: [] });

    await expect(findAttributionIdentityRefusal(db, claims('pepper-current'))).resolves.toBe(
      'membership_missing'
    );
  });
});
