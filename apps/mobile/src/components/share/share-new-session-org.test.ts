import { describe, expect, it } from 'vitest';

import { resolveShareNewSessionOrganization } from './share-new-session-org';

const DENIED = { selectedOrganizationAccessDenied: true } as const;
const ALLOWED = { selectedOrganizationAccessDenied: false } as const;
const SETTLED = { membershipsSettled: true, membershipsFailed: false } as const;

describe('resolveShareNewSessionOrganization', () => {
  it('keeps the selected organization when it is accessible', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-selected',
        membershipIds: ['org-selected', 'org-other'],
        ...SETTLED,
        ...ALLOWED,
      })
    ).toBe('org-selected');
  });

  it('falls back to the account default when the selection denies access', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-lost',
        membershipIds: ['org-first', 'org-second'],
        ...SETTLED,
        ...DENIED,
      })
    ).toBe('org-first');
  });

  it('never targets the denied organization itself', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-lost',
        membershipIds: ['org-lost', 'org-first'],
        ...SETTLED,
        ...DENIED,
      })
    ).toBe('org-first');
  });

  it('falls back to Personal when no other membership remains', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-lost',
        membershipIds: ['org-lost'],
        ...SETTLED,
        ...DENIED,
      })
    ).toBeNull();
  });

  it('keeps Personal personal', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: null,
        membershipIds: ['org-first'],
        ...SETTLED,
        ...DENIED,
      })
    ).toBeNull();
  });

  it('keeps the selection on a membership list miss alone, proven or not', () => {
    // A settled list that merely lacks the selection is not proof: it can be a
    // stale page, so no access failure means no move.
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-selected',
        membershipIds: [],
        ...SETTLED,
        ...ALLOWED,
      })
    ).toBe('org-selected');
  });

  it.each([
    { label: 'an unsettled list', membershipsSettled: false, membershipsFailed: false },
    { label: 'a failed list', membershipsSettled: true, membershipsFailed: true },
  ])('keeps the selection on $label even after an access denial', ({ ...list }) => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-lost',
        membershipIds: ['org-first'],
        ...list,
        ...DENIED,
      })
    ).toBe('org-lost');
  });

  it('keeps the selection while the list has no data yet', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-lost',
        membershipIds: undefined,
        ...SETTLED,
        ...DENIED,
      })
    ).toBe('org-lost');
  });
});
