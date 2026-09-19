import { describe, expect, it } from 'vitest';

import {
  buildProfileSelectorState,
  PROFILE_SELECTOR_KEYS as K,
  profileSelectorCountItems,
  type ProfileSelectorProfile,
} from './profile-selector-model';

function profile(
  overrides: Partial<ProfileSelectorProfile> & { id: string; name: string }
): ProfileSelectorProfile {
  return {
    varCount: 0,
    commandCount: 0,
    isDefault: false,
    ownerType: 'user',
    ...overrides,
  };
}

const ORG_PROFILE = profile({
  id: 'org-1',
  name: 'Org Backend',
  ownerType: 'organization',
  varCount: 3,
  commandCount: 1,
  isDefault: true,
});
const PERSONAL_PROFILE = profile({ id: 'user-1', name: 'My Setup', isDefault: false });
const PERSONAL_DEFAULT = profile({ id: 'user-2', name: 'My Default', isDefault: true });

const rowKinds = (state: ReturnType<typeof buildProfileSelectorState>) =>
  state.rows.map(row => row.kind);

const profileIds = (state: ReturnType<typeof buildProfileSelectorState>) =>
  state.rows.flatMap(row => (row.kind === 'profile' ? [row.profile.id] : []));

describe('profileSelectorCountItems', () => {
  it('resolves N vars and N cmds when either count is non-zero', () => {
    expect(
      profileSelectorCountItems(profile({ id: 'a', name: 'A', varCount: 3, commandCount: 1 }))
    ).toEqual([
      { kind: 'vars', count: 3 },
      { kind: 'commands', count: 1 },
    ]);
  });

  it('resolves nothing when both counts are zero', () => {
    expect(profileSelectorCountItems(profile({ id: 'a', name: 'A' }))).toEqual([]);
  });
});

describe('buildProfileSelectorState', () => {
  it('offers only No profile, Manage and repo defaults when there are no profiles', () => {
    const state = buildProfileSelectorState({
      organizationId: undefined,
      orgProfiles: [],
      personalProfiles: [],
      effectiveDefaultId: null,
      selectedProfileId: null,
    });

    expect(rowKinds(state)).toEqual(['none', 'manage', 'repo-defaults']);
    expect(state.rows[0]).toMatchObject({ kind: 'none', labelKey: K.noProfile });
    expect(state.rows[1]).toMatchObject({ kind: 'manage', labelKey: K.manageProfiles });
    expect(state.rows[2]).toMatchObject({
      kind: 'repo-defaults',
      labelKey: K.repoDefaults,
    });
    expect(state.selectedProfile).toBeNull();
    expect(state.selectedIsEffectiveDefault).toBe(false);
  });

  it('groups org then personal profiles in org context with the effective-default star', () => {
    const state = buildProfileSelectorState({
      organizationId: 'org-1',
      orgProfiles: [ORG_PROFILE],
      personalProfiles: [PERSONAL_PROFILE, PERSONAL_DEFAULT],
      effectiveDefaultId: 'org-1',
      selectedProfileId: null,
    });

    expect(rowKinds(state)).toEqual([
      'none',
      'header',
      'profile',
      'header',
      'profile',
      'profile',
      'manage',
      'repo-defaults',
    ]);
    expect(state.rows[1]).toMatchObject({ kind: 'header', labelKey: K.organizationProfiles });
    expect(state.rows[3]).toMatchObject({ kind: 'header', labelKey: K.personalProfiles });
    expect(profileIds(state)).toEqual(['org-1', 'user-1', 'user-2']);
    // Org context: the effective default id drives the star for both groups.
    expect(state.rows[2]).toMatchObject({ kind: 'profile', isEffectiveDefault: true });
    expect(state.rows[4]).toMatchObject({ kind: 'profile', isEffectiveDefault: false });
    expect(state.rows[5]).toMatchObject({ kind: 'profile', isEffectiveDefault: false });
  });

  it('uses the personal default flag in personal context with the Your Profiles title', () => {
    const state = buildProfileSelectorState({
      organizationId: undefined,
      orgProfiles: [ORG_PROFILE],
      personalProfiles: [PERSONAL_PROFILE, PERSONAL_DEFAULT],
      effectiveDefaultId: 'user-2',
      selectedProfileId: null,
    });

    // Org profiles are ignored outside an organization scope.
    expect(profileIds(state)).toEqual(['user-1', 'user-2']);
    expect(state.rows[1]).toMatchObject({ kind: 'header', labelKey: K.yourProfiles });
    expect(state.rows[2]).toMatchObject({ kind: 'profile', isEffectiveDefault: false });
    expect(state.rows[3]).toMatchObject({ kind: 'profile', isEffectiveDefault: true });
  });

  it('resolves the selected profile and its effective-default star', () => {
    const state = buildProfileSelectorState({
      organizationId: undefined,
      orgProfiles: [],
      personalProfiles: [PERSONAL_PROFILE, PERSONAL_DEFAULT],
      effectiveDefaultId: 'user-2',
      selectedProfileId: 'user-2',
    });

    expect(state.selectedProfile?.name).toBe('My Default');
    expect(state.selectedIsEffectiveDefault).toBe(true);
  });

  it('leaves the selected row empty when the id names nothing in the list', () => {
    const state = buildProfileSelectorState({
      organizationId: undefined,
      orgProfiles: [],
      personalProfiles: [PERSONAL_PROFILE],
      effectiveDefaultId: null,
      selectedProfileId: 'deleted',
    });

    expect(state.selectedProfile).toBeNull();
    expect(state.selectedIsEffectiveDefault).toBe(false);
  });

  it('omits the repo-defaults entry when the caller does not offer it', () => {
    const state = buildProfileSelectorState({
      organizationId: undefined,
      orgProfiles: [],
      personalProfiles: [],
      effectiveDefaultId: null,
      selectedProfileId: null,
      includeRepoDefaults: false,
    });

    expect(rowKinds(state)).toEqual(['none', 'manage']);
  });
});
