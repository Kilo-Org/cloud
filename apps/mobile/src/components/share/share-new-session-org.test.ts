import { describe, expect, it } from 'vitest';

import { resolveShareNewSessionOrganization } from './share-new-session-org';

const SETTLED = { membershipsSettled: true, membershipsFailed: false } as const;

describe('resolveShareNewSessionOrganization', () => {
  it('keeps the selected organization while the membership list holds it', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-selected',
        membershipIds: ['org-selected', 'org-other'],
        ...SETTLED,
      })
    ).toBe('org-selected');
  });

  it('falls back to the account default when the selection is no longer a membership', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-lost',
        membershipIds: ['org-first', 'org-second'],
        ...SETTLED,
      })
    ).toBe('org-first');
  });

  it('falls back to Personal when no membership remains', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-lost',
        membershipIds: [],
        ...SETTLED,
      })
    ).toBeNull();
  });

  it('keeps Personal personal', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: null,
        membershipIds: ['org-first'],
        ...SETTLED,
      })
    ).toBeNull();
  });

  it.each([
    { label: 'an unsettled list', membershipsSettled: false, membershipsFailed: false },
    { label: 'a failed list', membershipsSettled: true, membershipsFailed: true },
  ])('keeps the selection on $label', ({ membershipsSettled, membershipsFailed }) => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-selected',
        membershipIds: [],
        membershipsSettled,
        membershipsFailed,
      })
    ).toBe('org-selected');
  });

  it('keeps the selection while the list has no data yet', () => {
    expect(
      resolveShareNewSessionOrganization({
        organizationId: 'org-selected',
        membershipIds: undefined,
        ...SETTLED,
      })
    ).toBe('org-selected');
  });
});
