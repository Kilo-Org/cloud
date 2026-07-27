import { describe, expect, it, vi } from 'vitest';

import { hasOrganizationAccess } from './organization-membership.js';

type MembershipFixture = { kind: 'member' } | { kind: 'non-member' } | { kind: 'soft-deleted' };

function createMembershipDb(fixture: MembershipFixture) {
  const rows =
    fixture.kind === 'member'
      ? [{ id: 'mem_1' }]
      : // non-member and soft-deleted org both yield no row: the join requires
        // membership + organizations.deleted_at IS NULL.
        [];

  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));

  return { select, from, innerJoin, where, limit, rows };
}

describe('hasOrganizationAccess', () => {
  it('returns true when the user has a direct membership in a live org', async () => {
    const db = createMembershipDb({ kind: 'member' });

    await expect(
      hasOrganizationAccess(db as never, { kiloUserId: 'usr_1', organizationId: 'org_1' })
    ).resolves.toBe(true);

    expect(db.select).toHaveBeenCalledOnce();
    expect(db.from).toHaveBeenCalledOnce();
    expect(db.innerJoin).toHaveBeenCalledOnce();
    expect(db.where).toHaveBeenCalledOnce();
    expect(db.limit).toHaveBeenCalledWith(1);
  });

  it('returns false when the user has no membership row', async () => {
    const db = createMembershipDb({ kind: 'non-member' });

    await expect(
      hasOrganizationAccess(db as never, { kiloUserId: 'usr_1', organizationId: 'org_1' })
    ).resolves.toBe(false);
  });

  it('returns false when the user is a member of a soft-deleted org', async () => {
    // Soft-deleted orgs are filtered by isNull(organizations.deleted_at) on the
    // join, so the query returns no row — same as non-membership to the caller.
    const db = createMembershipDb({ kind: 'soft-deleted' });

    await expect(
      hasOrganizationAccess(db as never, {
        kiloUserId: 'usr_1',
        organizationId: 'org_deleted',
      })
    ).resolves.toBe(false);
  });
});
