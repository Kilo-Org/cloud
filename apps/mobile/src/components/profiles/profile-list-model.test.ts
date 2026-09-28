import { describe, expect, it } from 'vitest';

import {
  buildProfileSections,
  isEffectiveDefault,
  profileCounts,
  profileListCountItems,
} from '@/components/profiles/profile-list-model';

type TestProfile = {
  id: string;
  name: string;
  isDefault: boolean;
  varCount: number;
  commandCount: number;
  mcpServerCount: number;
  skillCount: number;
};

function profile(overrides: Partial<TestProfile> & { id: string }): TestProfile {
  return {
    name: 'Backend debugging',
    isDefault: false,
    varCount: 0,
    commandCount: 0,
    mcpServerCount: 0,
    skillCount: 0,
    ...overrides,
  };
}

const orgProfile = profile({ id: 'org-profile' });
const personalProfile = profile({ id: 'personal-profile' });

describe('buildProfileSections', () => {
  it('renders a personal context as one untitled section', () => {
    const sections = buildProfileSections({
      orgProfiles: [],
      personalProfiles: [personalProfile],
      isOrgContext: false,
    });

    expect(sections).toEqual([{ key: 'personal', profiles: [personalProfile] }]);
    expect(sections[0]?.titleKey).toBeUndefined();
  });

  it('orders an organization context Organization then Personal', () => {
    const sections = buildProfileSections({
      orgProfiles: [orgProfile],
      personalProfiles: [personalProfile],
      isOrgContext: true,
    });

    expect(sections.map(section => section.key)).toEqual(['organization', 'personal']);
    expect(sections.map(section => section.titleKey)).toEqual([
      'profiles.list.organizationHeading',
      'profiles.list.personalHeading',
    ]);
    expect(sections[0]?.profiles).toEqual([orgProfile]);
    expect(sections[1]?.profiles).toEqual([personalProfile]);
  });

  it('drops an empty group so no section header dangles', () => {
    const sections = buildProfileSections({
      orgProfiles: [],
      personalProfiles: [personalProfile],
      isOrgContext: true,
    });

    expect(sections).toEqual([
      { key: 'personal', titleKey: 'profiles.list.personalHeading', profiles: [personalProfile] },
    ]);
  });

  it('returns no sections when the context has no profiles', () => {
    expect(
      buildProfileSections({ orgProfiles: [], personalProfiles: [], isOrgContext: false })
    ).toEqual([]);
    expect(
      buildProfileSections({ orgProfiles: [], personalProfiles: [], isOrgContext: true })
    ).toEqual([]);
  });
});

describe('isEffectiveDefault', () => {
  it('marks only the profile that matches the resolved effective default', () => {
    expect(isEffectiveDefault(personalProfile, 'personal-profile')).toBe(true);
    expect(isEffectiveDefault(orgProfile, 'personal-profile')).toBe(false);
  });

  it('lets a personal default win over an org default', () => {
    // The server resolves `effectiveDefaultId` as personal default ?? org
    // default; both profiles carry `isDefault` locally.
    const orgDefault = profile({ id: 'org-default', isDefault: true });
    const personalDefault = profile({ id: 'personal-default', isDefault: true });
    const effectiveDefaultId = personalDefault.id;

    expect(isEffectiveDefault(personalDefault, effectiveDefaultId)).toBe(true);
    expect(isEffectiveDefault(orgDefault, effectiveDefaultId)).toBe(false);
  });

  it('falls back to the profile flag when no default is resolved', () => {
    expect(isEffectiveDefault(profile({ id: 'a', isDefault: true }), null)).toBe(true);
    expect(isEffectiveDefault(profile({ id: 'b' }), null)).toBe(false);
  });
});

describe('profileCounts', () => {
  it('returns the var / MCP / skill triple, not setup commands', () => {
    expect(
      profileCounts(
        profile({ id: 'a', varCount: 3, commandCount: 9, mcpServerCount: 2, skillCount: 1 })
      )
    ).toEqual({ varCount: 3, mcpServerCount: 2, skillCount: 1 });
  });
});

describe('profileListCountItems', () => {
  it('resolves the non-zero counts in web order', () => {
    expect(
      profileListCountItems(profile({ id: 'a', varCount: 3, mcpServerCount: 2, skillCount: 1 }))
    ).toEqual([
      { kind: 'vars', count: 3 },
      { kind: 'mcp', count: 2 },
      { kind: 'skills', count: 1 },
    ]);
    expect(profileListCountItems(profile({ id: 'a', mcpServerCount: 2 }))).toEqual([
      { kind: 'mcp', count: 2 },
    ]);
  });

  it('resolves nothing when every count is zero', () => {
    expect(profileListCountItems(profile({ id: 'a', commandCount: 2 }))).toEqual([]);
  });
});
