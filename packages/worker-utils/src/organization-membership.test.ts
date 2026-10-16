import { describe, expect, it, vi } from 'vitest';

import { hasOrganizationAccess } from './organization-membership.js';

type MembershipFixture = { kind: 'member' } | { kind: 'non-member' };

function createMembershipDb(fixture: MembershipFixture) {
  const rows = fixture.kind === 'member' ? [{ id: 'mem_1' }] : [];

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
});
