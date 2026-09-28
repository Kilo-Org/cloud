import { describe, expect, it } from 'vitest';

import {
  createOrganizationId,
  hasOrganizationContext,
  ownerChoices,
  profileOrganizationId,
  profileOwnerType,
  splitProfilesByOwner,
} from '@/components/profiles/profile-owner-model';

type TestProfile = {
  id: string;
  ownerType?: 'organization' | 'user';
};

function profile(overrides: Partial<TestProfile> & { id: string }): TestProfile {
  return { ...overrides };
}

const orgProfile = profile({ id: 'org-profile', ownerType: 'organization' });
const personalProfile = profile({ id: 'personal-profile', ownerType: 'user' });
const untaggedProfile = profile({ id: 'untagged-profile' });

describe('ownerChoices', () => {
  it('offers personal only without an organization context', () => {
    expect(ownerChoices(null)).toEqual(['personal']);
    expect(ownerChoices(undefined)).toEqual(['personal']);
  });

  it('offers personal and organization inside an organization context', () => {
    expect(ownerChoices('org-1')).toEqual(['personal', 'organization']);
  });
});

describe('hasOrganizationContext', () => {
  it('is true only for a non-null organization id', () => {
    expect(hasOrganizationContext('org-1')).toBe(true);
    expect(hasOrganizationContext(null)).toBe(false);
    expect(hasOrganizationContext(undefined)).toBe(false);
  });
});

describe('profileOwnerType', () => {
  it('reads the server owner tag, defaulting an untagged row to personal', () => {
    expect(profileOwnerType(orgProfile)).toBe('organization');
    expect(profileOwnerType(personalProfile)).toBe('personal');
    // `agentProfiles.list` does not tag personal rows.
    expect(profileOwnerType(untaggedProfile)).toBe('personal');
  });
});

describe('createOrganizationId', () => {
  it('sends the organization only for an organization-owned create', () => {
    expect(createOrganizationId('org-1', 'organization')).toBe('org-1');
  });

  it('never sends the organization for a personal create', () => {
    expect(createOrganizationId('org-1', 'personal')).toBeUndefined();
    expect(createOrganizationId(null, 'personal')).toBeUndefined();
  });

  it('cannot send an organization when no context is active', () => {
    expect(createOrganizationId(null, 'organization')).toBeUndefined();
    expect(createOrganizationId(undefined, 'organization')).toBeUndefined();
  });
});

describe('profileOrganizationId', () => {
  it('sends the context organization for an organization-owned profile', () => {
    expect(profileOrganizationId('org-1', orgProfile)).toBe('org-1');
  });

  it('sends no organization for a personal profile even inside an organization context', () => {
    expect(profileOrganizationId('org-1', personalProfile)).toBeUndefined();
    expect(profileOrganizationId('org-1', untaggedProfile)).toBeUndefined();
  });

  it('sends no organization when no context is active', () => {
    expect(profileOrganizationId(null, orgProfile)).toBeUndefined();
    expect(profileOrganizationId(undefined, orgProfile)).toBeUndefined();
  });
});

describe('splitProfilesByOwner', () => {
  it('reads both buckets from the combined list in an organization context', () => {
    const buckets = splitProfilesByOwner({
      isOrgContext: true,
      combined: { orgProfiles: [orgProfile], personalProfiles: [personalProfile] },
      personal: [untaggedProfile],
    });

    expect(buckets.orgProfiles).toEqual([orgProfile]);
    expect(buckets.personalProfiles).toEqual([personalProfile]);
  });

  it('ignores stale combined data in a personal context', () => {
    const buckets = splitProfilesByOwner({
      isOrgContext: false,
      combined: { orgProfiles: [orgProfile], personalProfiles: [personalProfile] },
      personal: [untaggedProfile],
    });

    expect(buckets.orgProfiles).toEqual([]);
    expect(buckets.personalProfiles).toEqual([untaggedProfile]);
  });

  it('returns empty buckets before any list data has loaded', () => {
    expect(splitProfilesByOwner({ isOrgContext: true })).toEqual({
      orgProfiles: [],
      personalProfiles: [],
    });
    expect(splitProfilesByOwner({ isOrgContext: false })).toEqual({
      orgProfiles: [],
      personalProfiles: [],
    });
  });
});
