import type { WorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { findAttributionIdentityRefusal } from './attribution-identity';

const USER_ID = 'user-123';
const ORGANIZATION_ID = 'org-123';

type AccountRow = { blockedAt: string | null; blockedReason: string | null };

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

describe('findAttributionIdentityRefusal', () => {
  it('admits an active member of the claimed organization', async () => {
    const db = database({
      account: [{ blockedAt: null, blockedReason: null }],
      membership: [{ role: 'member' }],
    });

    await expect(
      findAttributionIdentityRefusal(db, {
        kiloUserId: USER_ID,
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toBeNull();
  });

  it.each([
    ['a recorded block time', { blockedAt: '2026-10-31T00:00:00.000Z', blockedReason: null }],
    ['a recorded block reason', { blockedAt: null, blockedReason: 'abuse' }],
  ])('refuses an account with %s', async (_label, account) => {
    const db = database({ account: [account], membership: [{ role: 'member' }] });

    await expect(
      findAttributionIdentityRefusal(db, {
        kiloUserId: USER_ID,
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toBe('identity_blocked');
  });

  it('refuses an identity with no account row', async () => {
    const db = database({ account: [], membership: [{ role: 'member' }] });

    await expect(
      findAttributionIdentityRefusal(db, {
        kiloUserId: USER_ID,
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toBe('identity_missing');
  });

  it('refuses an active account with no membership row for the claimed organization', async () => {
    const db = database({ account: [{ blockedAt: null, blockedReason: null }], membership: [] });

    await expect(
      findAttributionIdentityRefusal(db, {
        kiloUserId: USER_ID,
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toBe('membership_missing');
  });
});
